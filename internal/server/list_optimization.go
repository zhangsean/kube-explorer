package server

import (
	"bytes"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const listCacheTTL = 15 * time.Second

var cachedListResponses = struct {
	sync.Mutex
	items map[string]cachedListResponse
}{
	items: map[string]cachedListResponse{},
}

type cachedListResponse struct {
	status int
	header http.Header
	body   []byte
	until  time.Time
}

func optimizeListRequests(next http.Handler, enablePrioritySnapshots bool) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
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
			writeCachedListResponse(rw, cached)
			return
		}

		recorder := newListResponseRecorder()
		next.ServeHTTP(recorder, req)
		recorder.writeTo(rw)

		if recorder.statusCode() == http.StatusOK && isJSONResponse(recorder.header) {
			setCachedListResponse(key, cachedListResponse{
				status: recorder.statusCode(),
				header: cloneHeader(recorder.header),
				body:   recorder.body.Bytes(),
				until:  time.Now().Add(listCacheTTL),
			})
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
	auth := req.Header.Get("Authorization")
	cookie := req.Header.Get("Cookie")
	return strings.Join([]string{req.Method, req.URL.Path, req.URL.RawQuery, auth, cookie}, "\x00")
}

func getCachedListResponse(key string) (cachedListResponse, bool) {
	cachedListResponses.Lock()
	defer cachedListResponses.Unlock()

	item, ok := cachedListResponses.items[key]
	if !ok {
		return cachedListResponse{}, false
	}
	if time.Now().After(item.until) {
		delete(cachedListResponses.items, key)
		return cachedListResponse{}, false
	}
	return item, true
}

func setCachedListResponse(key string, item cachedListResponse) {
	cachedListResponses.Lock()
	defer cachedListResponses.Unlock()
	cachedListResponses.items[key] = item
}

func writeCachedListResponse(rw http.ResponseWriter, cached cachedListResponse) {
	copyHeader(rw.Header(), cached.header)
	rw.Header().Set("X-Kube-Explorer-Cache", "HIT")
	rw.WriteHeader(cached.status)
	_, _ = rw.Write(cached.body)
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
