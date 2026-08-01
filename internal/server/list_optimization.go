package server

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
)

const (
	listCacheTTL        = 15 * time.Second
	listCacheMaxEntries = 128
	listCacheMaxBytes   = 64 << 20
)

var cachedListResponses = struct {
	sync.Mutex
	items      map[string]listCacheEntry
	totalBytes int64
	generation uint64
}{
	items: map[string]listCacheEntry{},
}

var listRequestGroup singleflight.Group

type cachedListResponse struct {
	status int
	header http.Header
	body   []byte
	until  time.Time
}

type listCacheEntry struct {
	response   cachedListResponse
	size       int64
	lastAccess time.Time
	generation uint64
}

func optimizeListRequests(next http.Handler, enablePrioritySnapshots bool) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		if isMutatingRequest(req) {
			recorder := &responseStatusWriter{ResponseWriter: rw}
			next.ServeHTTP(recorder, req)
			if recorder.statusCode() >= http.StatusOK && recorder.statusCode() < http.StatusMultipleChoices {
				invalidateListCaches()
			}
			return
		}

		if applyPriorityListFilter(req) {
			rw.Header().Set("X-Kube-Explorer-List-Filter", "priority")
		}

		if shouldLoadCompleteList(req) {
			loadCompleteList(req)
		}
		if enablePrioritySnapshots && servePriorityListSnapshot(rw, req, next) {
			return
		}

		if !isCacheableListRequest(req) {
			next.ServeHTTP(rw, req)
			return
		}

		key := listCacheKey(req)
		if cached, ok := getCachedListResponse(key); ok {
			recordListCacheRequest("hit")
			cached.header = cloneHeader(cached.header)
			cached.header.Set("X-Kube-Explorer-Cache", "HIT")
			writeCachedListResponse(rw, cached)
			return
		}
		recordListCacheRequest("miss")

		generation := listCacheGeneration()
		result := listRequestGroup.DoChan(key, func() (interface{}, error) {
			if cached, ok := getCachedListResponse(key); ok {
				return cached, nil
			}
			recorder := newListResponseRecorder()
			next.ServeHTTP(recorder, req)
			response := cachedListResponse{
				status: recorder.statusCode(),
				header: cloneHeader(recorder.header),
				body:   append([]byte(nil), recorder.body.Bytes()...),
			}
			if response.status == http.StatusOK && isJSONResponse(response.header) {
				response.until = time.Now().Add(listCacheTTL)
				setCachedListResponse(key, response, generation)
			}
			return response, nil
		})

		select {
		case <-req.Context().Done():
			return
		case resolved := <-result:
			if resolved.Err != nil {
				http.Error(rw, resolved.Err.Error(), http.StatusBadGateway)
				return
			}
			response := resolved.Val.(cachedListResponse)
			if resolved.Shared {
				recordListCacheRequest("coalesced")
				response.header = cloneHeader(response.header)
				response.header.Set("X-Kube-Explorer-Cache", "COALESCED")
			}
			writeCachedListResponse(rw, response)
		}
	})
}

var priorityListFilterFields = map[string]map[string][]string{
	"apps.deployment": {
		"/v1/apps.deployments": {
			"metadata.name",
			"metadata.namespace",
			"spec.template.spec.containers.image",
			"spec.template.spec.initContainers.image",
		},
		"/v1/apps.replicasets": {
			"metadata.name",
			"metadata.namespace",
			"spec.template.spec.containers.image",
			"spec.template.spec.initContainers.image",
		},
		"/v1/pods": {
			"metadata.name",
			"metadata.namespace",
			"spec.containers.image",
			"spec.initContainers.image",
		},
	},
}

func applyPriorityListFilter(req *http.Request) bool {
	if req.Method != http.MethodGet || req.URL == nil || req.URL.Query().Get("continue") != "" {
		return false
	}

	referrer, err := url.Parse(req.Referer())
	if err != nil {
		return false
	}
	resource := listedResourceFromPath(referrer.Path)
	fields := priorityListFilterFields[resource][req.URL.Path]
	keyword := strings.TrimSpace(req.Header.Get("X-Kube-Explorer-List-Filter-Keyword"))
	if keyword == "" {
		keyword = strings.TrimSpace(referrer.Query().Get("q"))
	}
	if len(fields) == 0 || !isSafePriorityFilterKeyword(keyword) {
		return false
	}

	filters := make([]string, 0, len(fields))
	for _, field := range fields {
		filters = append(filters, field+"="+keyword)
	}
	query := req.URL.Query()
	query.Add("filter", strings.Join(filters, ","))
	req.URL.RawQuery = query.Encode()
	return true
}

func listedResourceFromPath(path string) string {
	const marker = "/explorer/"
	index := strings.LastIndex(path, marker)
	if index < 0 {
		return ""
	}
	resource := strings.Trim(path[index+len(marker):], "/")
	if resource == "" || strings.Contains(resource, "/") {
		return ""
	}
	return resource
}

func isSafePriorityFilterKeyword(keyword string) bool {
	if keyword == "" || len(keyword) > 128 {
		return false
	}
	for _, char := range keyword {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' {
			continue
		}
		switch char {
		case '.', '_', ':', '/', '@', '-':
			continue
		default:
			return false
		}
	}
	return true
}

func isJSONResponse(header http.Header) bool {
	return strings.Contains(strings.ToLower(header.Get("Content-Type")), "application/json")
}

func shouldLoadCompleteList(req *http.Request) bool {
	if req.Method != http.MethodGet || req.URL == nil || req.URL.Query().Get("continue") != "" {
		return false
	}

	switch req.URL.Path {
	case "/v1/pods", "/v1/apps.deployments", "/v1/apps.replicasets":
		return true
	default:
		return false
	}
}

func loadCompleteList(req *http.Request) {
	query := req.URL.Query()
	if query.Get("limit") == "" {
		return
	}
	query.Del("limit")
	req.URL.RawQuery = query.Encode()
}

func isCacheableListRequest(req *http.Request) bool {
	if req.Method != http.MethodGet || req.URL == nil {
		return false
	}
	query := req.URL.Query()
	if query.Get("watch") == "true" || query.Get("continue") != "" {
		return false
	}
	switch req.URL.Path {
	case "/v1/pods", "/v1/nodes", "/v1/metrics.k8s.io.pods", "/v1/metrics.k8s.io.nodes", "/v1/apps.deployments", "/v1/apps.replicasets":
		return true
	default:
		return false
	}
}

func listCacheKey(req *http.Request) string {
	identity := sha256.Sum256([]byte(req.Header.Get("Authorization") + "\x00" + req.Header.Get("Cookie")))
	return strings.Join([]string{
		req.Method,
		req.URL.Path,
		req.URL.RawQuery,
		requestBaseURL(req),
		req.Header.Get("X-Forwarded-Prefix"),
		req.Header.Get("Accept"),
		fmt.Sprintf("%x", identity),
	}, "\x00")
}

func getCachedListResponse(key string) (cachedListResponse, bool) {
	cachedListResponses.Lock()
	defer cachedListResponses.Unlock()

	now := time.Now()
	removeExpiredListCacheEntriesLocked(now)
	entry, ok := cachedListResponses.items[key]
	if !ok {
		return cachedListResponse{}, false
	}
	entry.lastAccess = now
	cachedListResponses.items[key] = entry
	return entry.response, true
}

func setCachedListResponse(key string, response cachedListResponse, generation uint64) {
	cachedListResponses.Lock()
	defer cachedListResponses.Unlock()
	if generation != cachedListResponses.generation {
		return
	}

	now := time.Now()
	removeExpiredListCacheEntriesLocked(now)
	size := cachedListResponseSize(response)
	if size > listCacheMaxBytes {
		recordListCacheEviction("oversize")
		return
	}
	if current, ok := cachedListResponses.items[key]; ok {
		cachedListResponses.totalBytes -= current.size
	}
	cachedListResponses.items[key] = listCacheEntry{
		response:   response,
		size:       size,
		lastAccess: now,
		generation: generation,
	}
	cachedListResponses.totalBytes += size
	evictListCacheEntriesLocked()
	updateListCacheGauges(len(cachedListResponses.items), cachedListResponses.totalBytes)
}

func writeCachedListResponse(rw http.ResponseWriter, cached cachedListResponse) {
	copyHeader(rw.Header(), cached.header)
	rw.WriteHeader(cached.status)
	_, _ = rw.Write(cached.body)
}

func listCacheGeneration() uint64 {
	cachedListResponses.Lock()
	defer cachedListResponses.Unlock()
	return cachedListResponses.generation
}

func invalidateListCaches() {
	cachedListResponses.Lock()
	cachedListResponses.items = map[string]listCacheEntry{}
	cachedListResponses.totalBytes = 0
	cachedListResponses.generation++
	cachedListResponses.Unlock()
	updateListCacheGauges(0, 0)
	recordListCacheInvalidation()
	invalidatePriorityListSnapshots()
}

func cleanupListCaches() {
	cachedListResponses.Lock()
	removeExpiredListCacheEntriesLocked(time.Now())
	entries := len(cachedListResponses.items)
	bytes := cachedListResponses.totalBytes
	cachedListResponses.Unlock()
	updateListCacheGauges(entries, bytes)
	cleanupPriorityListSnapshots()
}

func runListCacheJanitor(ctxDone <-chan struct{}, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctxDone:
			return
		case <-ticker.C:
			cleanupListCaches()
		}
	}
}

func removeExpiredListCacheEntriesLocked(now time.Time) {
	for key, entry := range cachedListResponses.items {
		if entry.response.until.IsZero() || now.Before(entry.response.until) {
			continue
		}
		delete(cachedListResponses.items, key)
		cachedListResponses.totalBytes -= entry.size
		recordListCacheEviction("expired")
	}
}

func evictListCacheEntriesLocked() {
	for len(cachedListResponses.items) > listCacheMaxEntries || cachedListResponses.totalBytes > listCacheMaxBytes {
		var oldestKey string
		var oldestTime time.Time
		for key, entry := range cachedListResponses.items {
			if oldestKey == "" || entry.lastAccess.Before(oldestTime) {
				oldestKey = key
				oldestTime = entry.lastAccess
			}
		}
		if oldestKey == "" {
			break
		}
		entry := cachedListResponses.items[oldestKey]
		delete(cachedListResponses.items, oldestKey)
		cachedListResponses.totalBytes -= entry.size
		recordListCacheEviction("capacity")
	}
}

func cachedListResponseSize(response cachedListResponse) int64 {
	size := int64(len(response.body))
	for key, values := range response.header {
		size += int64(len(key))
		for _, value := range values {
			size += int64(len(value))
		}
	}
	return size
}

func isMutatingRequest(req *http.Request) bool {
	if req == nil {
		return false
	}
	switch req.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

type responseStatusWriter struct {
	http.ResponseWriter
	status int
}

func (w *responseStatusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *responseStatusWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(body)
}

func (w *responseStatusWriter) statusCode() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func (w *responseStatusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *responseStatusWriter) Flush() {
	_ = http.NewResponseController(w.ResponseWriter).Flush()
}

func (w *responseStatusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return http.NewResponseController(w.ResponseWriter).Hijack()
}

func (w *responseStatusWriter) Push(target string, opts *http.PushOptions) error {
	if pusher, ok := w.ResponseWriter.(http.Pusher); ok {
		return pusher.Push(target, opts)
	}
	return http.ErrNotSupported
}

type listResponseRecorder struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func newListResponseRecorder() *listResponseRecorder {
	return &listResponseRecorder{
		header: http.Header{},
	}
}

func (r *listResponseRecorder) Header() http.Header {
	return r.header
}

func (r *listResponseRecorder) Write(data []byte) (int, error) {
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(data)
}

func (r *listResponseRecorder) WriteHeader(status int) {
	if r.status == 0 {
		r.status = status
	}
}

func (r *listResponseRecorder) statusCode() int {
	if r.status == 0 {
		return http.StatusOK
	}
	return r.status
}

func (r *listResponseRecorder) writeTo(rw http.ResponseWriter) {
	copyHeader(rw.Header(), r.header)
	rw.WriteHeader(r.statusCode())
	_, _ = rw.Write(r.body.Bytes())
}

func cloneHeader(input http.Header) http.Header {
	output := http.Header{}
	copyHeader(output, input)
	return output
}

func copyHeader(dst, src http.Header) {
	for key, values := range src {
		dst.Del(key)
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
