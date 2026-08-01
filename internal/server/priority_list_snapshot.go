package server

import (
	"bytes"
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
	priorityListSnapshotMaxAge = time.Minute
	priorityListPrewarmHost    = "kube-explorer.local"
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

var priorityListSnapshots = struct {
	sync.Mutex
	items      map[string]priorityListSnapshot
	refreshing map[string]bool
}{
	items:      map[string]priorityListSnapshot{},
	refreshing: map[string]bool{},
}

func prewarmPriorityLists(ctx context.Context, next http.Handler) {
	var group sync.WaitGroup
	for path := range priorityListFilterFields["apps.deployment"] {
		path := path
		group.Add(1)
		go func() {
			defer group.Done()
			req, err := http.NewRequestWithContext(
				ctx,
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
	group.Wait()
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

	if time.Since(snapshot.refreshedAt) > priorityListSnapshotMaxAge {
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
	clone := req.Clone(context.Background())
	query := clone.URL.Query()
	query.Del("filter")
	query.Del("limit")
	clone.URL.RawQuery = query.Encode()
	clone.Header.Del("X-Kube-Explorer-List-Filter-Keyword")
	go refreshPriorityListSnapshot(next, clone)
}

func refreshPriorityListSnapshot(next http.Handler, req *http.Request) {
	key, ok := priorityListSnapshotKey(req)
	if !ok || !beginPriorityListSnapshotRefresh(key) {
		return
	}
	defer endPriorityListSnapshotRefresh(key)

	recorder := newListResponseRecorder()
	next.ServeHTTP(recorder, req)
	if recorder.statusCode() != http.StatusOK || !isJSONResponse(recorder.header) {
		return
	}
	snapshot, err := preparePriorityListSnapshot(req, cachedListResponse{
		status: recorder.statusCode(),
		header: cloneHeader(recorder.header),
		body:   append([]byte(nil), recorder.body.Bytes()...),
	})
	if err != nil {
		return
	}
	setPriorityListSnapshot(key, snapshot)
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
	snapshot, ok := priorityListSnapshots.items[key]
	return snapshot, ok
}

func setPriorityListSnapshot(key string, snapshot priorityListSnapshot) {
	priorityListSnapshots.Lock()
	defer priorityListSnapshots.Unlock()
	priorityListSnapshots.items[key] = snapshot
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
	filtered := make([]json.RawMessage, 0, len(snapshot.items))
	for _, item := range snapshot.items {
		if strings.Contains(item.searchText, keyword) {
			filtered = append(filtered, item.body)
		}
	}

	collection := make(map[string]json.RawMessage, len(snapshot.envelope)+2)
	for key, value := range snapshot.envelope {
		collection[key] = value
	}
	data, err := json.Marshal(filtered)
	if err != nil {
		return cachedListResponse{}, err
	}
	count, err := json.Marshal(len(filtered))
	if err != nil {
		return cachedListResponse{}, err
	}
	collection["data"] = data
	collection["count"] = count
	body, err := json.Marshal(collection)
	if err != nil {
		return cachedListResponse{}, err
	}
	if toBase := requestBaseURL(req); snapshot.baseURL != "" && toBase != "" && snapshot.baseURL != toBase {
		body = bytes.ReplaceAll(body, []byte(snapshot.baseURL), []byte(toBase))
	}
	header := cloneHeader(snapshot.response.header)
	header.Del("Content-Length")
	return cachedListResponse{
		status: snapshot.response.status,
		header: header,
		body:   body,
	}, nil
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
