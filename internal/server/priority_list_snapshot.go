package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"
)

const (
	priorityListSnapshotRefreshAfter = 30 * time.Second
	priorityListSnapshotMaxAge       = time.Minute
	priorityListSnapshotMaxEntries   = 16
	priorityListSnapshotMaxBytes     = 64 << 20
	priorityListRefreshTimeout       = 15 * time.Second
	priorityListPrewarmHost          = "kube-explorer.local"
)

type priorityListSnapshot struct {
	response    cachedListResponse
	envelope    map[string]json.RawMessage
	items       []priorityListSnapshotItem
	baseURL     string
	refreshedAt time.Time
}

type priorityListSnapshotItem struct {
	body       json.RawMessage
	searchText string
}

type priorityListSnapshotEntry struct {
	snapshot   priorityListSnapshot
	size       int64
	lastAccess time.Time
}

var priorityListSnapshots = struct {
	sync.Mutex
	items      map[string]priorityListSnapshotEntry
	refreshing map[string]bool
	totalBytes int64
	generation uint64
}{
	items:      map[string]priorityListSnapshotEntry{},
	refreshing: map[string]bool{},
}

func startPriorityListPrewarm(ctx context.Context, next http.Handler) {
	prewarmPriorityListsOnce(ctx, next)
	go func() {
		ticker := time.NewTicker(priorityListSnapshotRefreshAfter)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				prewarmPriorityListsOnce(ctx, next)
			}
		}
	}()
}

func prewarmPriorityListsOnce(ctx context.Context, next http.Handler) {
	for path := range priorityListFilterFields["apps.deployment"] {
		path := path
		go func() {
			refreshCtx, cancel := context.WithTimeout(ctx, priorityListRefreshTimeout)
			defer cancel()
			req, err := http.NewRequestWithContext(
				refreshCtx,
				http.MethodGet,
				"http://"+priorityListPrewarmHost+path+"?exclude=metadata.managedFields",
				nil,
			)
			if err != nil {
				return
			}
			req.Header.Set("Accept", "application/json")
			refreshPriorityListSnapshot(next, req)
			if key, ok := priorityListSnapshotKey(req); ok {
				if _, found := getPriorityListSnapshot(key); !found {
					logrus.Warnf("failed to prewarm priority list snapshot for %s", path)
				}
			}
		}()
	}
}

func servePriorityListSnapshot(rw http.ResponseWriter, req *http.Request, next http.Handler) bool {
	if !isPriorityListPageRequest(req) {
		return false
	}

	keyword := priorityListKeyword(req)
	if keyword != "" && !isSafePriorityFilterKeyword(keyword) {
		return false
	}

	key, ok := priorityListSnapshotKey(req)
	if !ok {
		return false
	}
	snapshot, ok := getPriorityListSnapshot(key)
	if !ok {
		refreshPriorityListSnapshotAsync(next, req)
		return false
	}
	age := time.Since(snapshot.refreshedAt)
	if age > priorityListSnapshotMaxAge {
		refreshPriorityListSnapshotAsync(next, req)
		return false
	}

	filtered, err := filterPriorityListSnapshot(snapshot, req, keyword)
	if err != nil {
		return false
	}
	copyHeader(rw.Header(), filtered.header)
	rw.Header().Set("X-Kube-Explorer-Cache", "SNAPSHOT")
	rw.WriteHeader(filtered.status)
	_, _ = rw.Write(filtered.body)

	if age > priorityListSnapshotRefreshAfter {
		refreshPriorityListSnapshotAsync(next, req)
	}
	return true
}

func isPriorityListPageRequest(req *http.Request) bool {
	if req == nil {
		return false
	}
	referrer, err := url.Parse(req.Referer())
	if err != nil {
		return false
	}
	return listedResourceFromPath(referrer.Path) == "apps.deployment"
}

func priorityListKeyword(req *http.Request) string {
	const filterHeader = "X-Kube-Explorer-List-Filter-Keyword"
	if _, found := req.Header[http.CanonicalHeaderKey(filterHeader)]; found {
		return strings.TrimSpace(req.Header.Get(filterHeader))
	}
	referrer, err := url.Parse(req.Referer())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(referrer.Query().Get("q"))
}

func priorityListSnapshotKey(req *http.Request) (string, bool) {
	if req == nil || req.URL == nil || len(priorityListFilterFields["apps.deployment"][req.URL.Path]) == 0 {
		return "", false
	}
	query := req.URL.Query()
	if query.Get("continue") != "" || query.Get("watch") == "true" {
		return "", false
	}
	query.Del("filter")
	query.Del("limit")
	return req.URL.Path + "\x00" + query.Encode(), true
}

func refreshPriorityListSnapshotAsync(next http.Handler, req *http.Request) {
	refreshCtx, cancel := context.WithTimeout(context.Background(), priorityListRefreshTimeout)
	clone := req.Clone(refreshCtx)
	query := clone.URL.Query()
	query.Del("filter")
	query.Del("limit")
	clone.URL.RawQuery = query.Encode()
	clone.Header.Del("X-Kube-Explorer-List-Filter-Keyword")
	go func() {
		defer cancel()
		refreshPriorityListSnapshot(next, clone)
	}()
}

func refreshPriorityListSnapshot(next http.Handler, req *http.Request) {
	started := time.Now()
	key, ok := priorityListSnapshotKey(req)
	if !ok || !beginPriorityListSnapshotRefresh(key) {
		return
	}
	defer endPriorityListSnapshotRefresh(key)
	generation := priorityListSnapshotGeneration()

	recorder := newListResponseRecorder()
	next.ServeHTTP(recorder, req)
	if recorder.statusCode() != http.StatusOK || !isJSONResponse(recorder.header) {
		recordPrioritySnapshotRefresh(req.URL.Path, "response_error", started)
		return
	}
	snapshot, err := preparePriorityListSnapshot(req, cachedListResponse{
		status: recorder.statusCode(),
		header: cloneHeader(recorder.header),
		body:   append([]byte(nil), recorder.body.Bytes()...),
	})
	if err != nil {
		logrus.Warnf("failed decoding priority list snapshot for %s: %v", req.URL.Path, err)
		recordPrioritySnapshotRefresh(req.URL.Path, "decode_error", started)
		return
	}
	if !setPriorityListSnapshot(key, snapshot, generation) {
		recordPrioritySnapshotRefresh(req.URL.Path, "invalidated", started)
		return
	}
	recordPrioritySnapshotRefresh(req.URL.Path, "success", started)
}

func beginPriorityListSnapshotRefresh(key string) bool {
	priorityListSnapshots.Lock()
	defer priorityListSnapshots.Unlock()
	if priorityListSnapshots.refreshing[key] {
		return false
	}
	priorityListSnapshots.refreshing[key] = true
	return true
}

func endPriorityListSnapshotRefresh(key string) {
	priorityListSnapshots.Lock()
	defer priorityListSnapshots.Unlock()
	delete(priorityListSnapshots.refreshing, key)
}

func getPriorityListSnapshot(key string) (priorityListSnapshot, bool) {
	priorityListSnapshots.Lock()
	defer priorityListSnapshots.Unlock()
	entry, ok := priorityListSnapshots.items[key]
	if !ok {
		return priorityListSnapshot{}, false
	}
	entry.lastAccess = time.Now()
	priorityListSnapshots.items[key] = entry
	return entry.snapshot, true
}

func setPriorityListSnapshot(key string, snapshot priorityListSnapshot, generation uint64) bool {
	priorityListSnapshots.Lock()
	defer priorityListSnapshots.Unlock()
	if generation != priorityListSnapshots.generation {
		return false
	}
	size := priorityListSnapshotSize(snapshot)
	if size > priorityListSnapshotMaxBytes {
		return false
	}
	if current, ok := priorityListSnapshots.items[key]; ok {
		priorityListSnapshots.totalBytes -= current.size
	}
	priorityListSnapshots.items[key] = priorityListSnapshotEntry{
		snapshot:   snapshot,
		size:       size,
		lastAccess: time.Now(),
	}
	priorityListSnapshots.totalBytes += size
	evictPriorityListSnapshotsLocked()
	updatePrioritySnapshotGauges(len(priorityListSnapshots.items), priorityListSnapshots.totalBytes)
	return true
}

func priorityListSnapshotGeneration() uint64 {
	priorityListSnapshots.Lock()
	defer priorityListSnapshots.Unlock()
	return priorityListSnapshots.generation
}

func invalidatePriorityListSnapshots() {
	priorityListSnapshots.Lock()
	priorityListSnapshots.items = map[string]priorityListSnapshotEntry{}
	priorityListSnapshots.totalBytes = 0
	priorityListSnapshots.generation++
	priorityListSnapshots.Unlock()
	updatePrioritySnapshotGauges(0, 0)
}

func cleanupPriorityListSnapshots() {
	priorityListSnapshots.Lock()
	now := time.Now()
	for key, entry := range priorityListSnapshots.items {
		if now.Sub(entry.snapshot.refreshedAt) <= priorityListSnapshotMaxAge {
			continue
		}
		delete(priorityListSnapshots.items, key)
		priorityListSnapshots.totalBytes -= entry.size
	}
	entries := len(priorityListSnapshots.items)
	bytes := priorityListSnapshots.totalBytes
	priorityListSnapshots.Unlock()
	updatePrioritySnapshotGauges(entries, bytes)
}

func evictPriorityListSnapshotsLocked() {
	for len(priorityListSnapshots.items) > priorityListSnapshotMaxEntries || priorityListSnapshots.totalBytes > priorityListSnapshotMaxBytes {
		var oldestKey string
		var oldestTime time.Time
		for key, entry := range priorityListSnapshots.items {
			if oldestKey == "" || entry.lastAccess.Before(oldestTime) {
				oldestKey = key
				oldestTime = entry.lastAccess
			}
		}
		if oldestKey == "" {
			break
		}
		entry := priorityListSnapshots.items[oldestKey]
		delete(priorityListSnapshots.items, oldestKey)
		priorityListSnapshots.totalBytes -= entry.size
	}
}

func priorityListSnapshotSize(snapshot priorityListSnapshot) int64 {
	var size int64
	for key, value := range snapshot.envelope {
		size += int64(len(key) + len(value))
	}
	for _, item := range snapshot.items {
		size += int64(len(item.body) + len(item.searchText))
	}
	for key, values := range snapshot.response.header {
		size += int64(len(key))
		for _, value := range values {
			size += int64(len(value))
		}
	}
	return size
}

func preparePriorityListSnapshot(req *http.Request, response cachedListResponse) (priorityListSnapshot, error) {
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(response.body, &envelope); err != nil {
		return priorityListSnapshot{}, err
	}
	var data []json.RawMessage
	if err := json.Unmarshal(envelope["data"], &data); err != nil {
		return priorityListSnapshot{}, err
	}
	delete(envelope, "data")
	delete(envelope, "count")

	fields := priorityListFilterFields["apps.deployment"][req.URL.Path]
	items := make([]priorityListSnapshotItem, 0, len(data))
	for _, body := range data {
		var item interface{}
		if err := json.Unmarshal(body, &item); err != nil {
			return priorityListSnapshot{}, err
		}
		var searchable []string
		for _, field := range fields {
			searchable = append(searchable, priorityListFieldValues(item, strings.Split(field, "."))...)
		}
		items = append(items, priorityListSnapshotItem{
			body:       append(json.RawMessage(nil), body...),
			searchText: strings.ToLower(strings.Join(searchable, "\x00")),
		})
	}
	response.body = nil
	return priorityListSnapshot{
		response:    response,
		envelope:    envelope,
		items:       items,
		baseURL:     requestBaseURL(req),
		refreshedAt: time.Now(),
	}, nil
}

func filterPriorityListSnapshot(snapshot priorityListSnapshot, req *http.Request, keyword string) (cachedListResponse, error) {
	keyword = strings.ToLower(keyword)
	filtered := make([]interface{}, 0, len(snapshot.items))
	for _, item := range snapshot.items {
		if !strings.Contains(item.searchText, keyword) {
			continue
		}
		var decoded interface{}
		if err := json.Unmarshal(item.body, &decoded); err != nil {
			return cachedListResponse{}, err
		}
		filtered = append(filtered, decoded)
	}

	collection := make(map[string]interface{}, len(snapshot.envelope)+2)
	for key, value := range snapshot.envelope {
		var decoded interface{}
		if err := json.Unmarshal(value, &decoded); err != nil {
			return cachedListResponse{}, err
		}
		collection[key] = decoded
	}
	collection["data"] = filtered
	collection["count"] = len(filtered)
	if toBase := requestBaseURL(req); snapshot.baseURL != "" && toBase != "" && snapshot.baseURL != toBase {
		rewritePriorityListLinks(collection, snapshot.baseURL, toBase)
	}
	body, err := json.Marshal(collection)
	if err != nil {
		return cachedListResponse{}, err
	}
	header := cloneHeader(snapshot.response.header)
	header.Del("Content-Length")
	return cachedListResponse{
		status: snapshot.response.status,
		header: header,
		body:   body,
	}, nil
}

func rewritePriorityListLinks(value interface{}, fromBase, toBase string) {
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, child := range typed {
			if key == "links" {
				if links, ok := child.(map[string]interface{}); ok {
					for name, raw := range links {
						link, ok := raw.(string)
						if ok && isURLUnderBase(link, fromBase) {
							links[name] = toBase + strings.TrimPrefix(link, fromBase)
						}
					}
				}
			}
			rewritePriorityListLinks(child, fromBase, toBase)
		}
	case []interface{}:
		for _, child := range typed {
			rewritePriorityListLinks(child, fromBase, toBase)
		}
	}
}

func isURLUnderBase(value, base string) bool {
	if value == base {
		return true
	}
	return strings.HasPrefix(value, base+"/")
}

func priorityListItemMatches(item interface{}, fields []string, keyword string) bool {
	keyword = strings.ToLower(keyword)
	for _, field := range fields {
		values := priorityListFieldValues(item, strings.Split(field, "."))
		for _, value := range values {
			if strings.Contains(strings.ToLower(value), keyword) {
				return true
			}
		}
	}
	return false
}

func priorityListFieldValues(value interface{}, path []string) []string {
	if len(path) == 0 {
		if text, ok := value.(string); ok {
			return []string{text}
		}
		return nil
	}
	switch typed := value.(type) {
	case map[string]interface{}:
		return priorityListFieldValues(typed[path[0]], path[1:])
	case []interface{}:
		var result []string
		for _, item := range typed {
			result = append(result, priorityListFieldValues(item, path)...)
		}
		return result
	default:
		return nil
	}
}

func requestBaseURL(req *http.Request) string {
	scheme := req.URL.Scheme
	if forwarded := strings.TrimSpace(strings.Split(req.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded != "" {
		scheme = forwarded
	}
	if scheme == "" {
		if req.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	return scheme + "://" + req.Host
}
