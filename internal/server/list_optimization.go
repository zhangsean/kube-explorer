package server

import (
	"bytes"
	"net/http"
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

func optimizeListRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		if shouldLoadCompleteList(req) {
			loadCompleteList(req)
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
