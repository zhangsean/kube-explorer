package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFilterPriorityListSnapshot(t *testing.T) {
	body := `{
		"type":"collection",
		"count":3,
		"links":{"self":"http://kube-explorer.local/v1/apps.deployments"},
		"data":[
			{"metadata":{"name":"v4-api","namespace":"test"},"spec":{"template":{"spec":{"containers":[{"image":"example/api:v1"}]}}},"links":{"self":"http://kube-explorer.local/v1/apps.deployments/test/v4-api","view":"http://kube-explorer.local/apis/apps/v1/namespaces/test/deployments/v4-api"}},
			{"metadata":{"name":"worker","namespace":"test"},"spec":{"template":{"spec":{"containers":[{"image":"example/worker:v4"}]}}}},
			{"metadata":{"name":"other","namespace":"test"},"spec":{"template":{"spec":{"containers":[{"image":"example/other:v1"}]}}}}
		]
	}`
	prewarmRequest := httptest.NewRequest(http.MethodGet, "http://kube-explorer.local/v1/apps.deployments?exclude=metadata.managedFields", nil)
	snapshot, err := preparePriorityListSnapshot(prewarmRequest, cachedListResponse{
		status: http.StatusOK,
		header: http.Header{
			"Content-Type":   []string{"application/json"},
			"Content-Length": []string{"999"},
		},
		body: []byte(body),
	})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "https://exp-dev.example/v1/apps.deployments?exclude=metadata.managedFields", nil)
	filtered, err := filterPriorityListSnapshot(snapshot, req, "v4")
	if err != nil {
		t.Fatal(err)
	}
	if got := filtered.header.Get("Content-Length"); got != "" {
		t.Fatalf("content length = %q, want empty", got)
	}

	var collection struct {
		Count int               `json:"count"`
		Links map[string]string `json:"links"`
		Data  []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Links map[string]string `json:"links"`
		} `json:"data"`
	}
	if err := json.Unmarshal(filtered.body, &collection); err != nil {
		t.Fatal(err)
	}
	if collection.Count != 2 || len(collection.Data) != 2 {
		t.Fatalf("filtered count = %d/%d, want 2/2", collection.Count, len(collection.Data))
	}
	if collection.Data[0].Metadata.Name != "v4-api" || collection.Data[1].Metadata.Name != "worker" {
		t.Fatalf("filtered names = %q, %q", collection.Data[0].Metadata.Name, collection.Data[1].Metadata.Name)
	}
	if got := collection.Links["self"]; got != "https://exp-dev.example/v1/apps.deployments" {
		t.Fatalf("collection self link = %q", got)
	}
	if got := collection.Data[0].Links["self"]; got != "https://exp-dev.example/v1/apps.deployments/test/v4-api" {
		t.Fatalf("resource self link = %q", got)
	}
	if got := collection.Data[0].Links["view"]; got != "https://exp-dev.example/apis/apps/v1/namespaces/test/deployments/v4-api" {
		t.Fatalf("resource view link = %q", got)
	}
}

func TestServePriorityListSnapshot(t *testing.T) {
	resetPriorityListSnapshotsForTest()
	t.Cleanup(resetPriorityListSnapshotsForTest)

	req := httptest.NewRequest(http.MethodGet, "https://exp-dev.example/v1/apps.deployments?exclude=metadata.managedFields", nil)
	req.Header.Set("Referer", "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment")
	req.Header.Set("X-Kube-Explorer-List-Filter-Keyword", "v4")
	key, ok := priorityListSnapshotKey(req)
	if !ok {
		t.Fatal("expected snapshot key")
	}
	prewarmRequest := httptest.NewRequest(http.MethodGet, "http://kube-explorer.local/v1/apps.deployments?exclude=metadata.managedFields", nil)
	snapshot, err := preparePriorityListSnapshot(prewarmRequest, cachedListResponse{
		status: http.StatusOK,
		header: http.Header{"Content-Type": []string{"application/json"}},
		body:   []byte(`{"count":1,"data":[{"metadata":{"name":"v4-api"}}]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot.refreshedAt = time.Now()
	setPriorityListSnapshot(key, snapshot)

	recorder := httptest.NewRecorder()
	if !servePriorityListSnapshot(recorder, req, http.NotFoundHandler()) {
		t.Fatal("expected snapshot response")
	}
	if got := recorder.Header().Get("X-Kube-Explorer-Cache"); got != "SNAPSHOT" {
		t.Fatalf("cache header = %q, want SNAPSHOT", got)
	}
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
}

func TestServePriorityListSnapshotWithExplicitEmptyKeyword(t *testing.T) {
	resetPriorityListSnapshotsForTest()
	t.Cleanup(resetPriorityListSnapshotsForTest)

	req := httptest.NewRequest(http.MethodGet, "https://exp-dev.example/v1/apps.deployments?exclude=metadata.managedFields", nil)
	req.Header.Set("Referer", "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment?q=stale")
	req.Header[http.CanonicalHeaderKey("X-Kube-Explorer-List-Filter-Keyword")] = []string{""}
	key, ok := priorityListSnapshotKey(req)
	if !ok {
		t.Fatal("expected snapshot key")
	}
	prewarmRequest := httptest.NewRequest(http.MethodGet, "http://kube-explorer.local/v1/apps.deployments?exclude=metadata.managedFields", nil)
	snapshot, err := preparePriorityListSnapshot(prewarmRequest, cachedListResponse{
		status: http.StatusOK,
		header: http.Header{"Content-Type": []string{"application/json"}},
		body:   []byte(`{"count":2,"data":[{"metadata":{"name":"v4-api"}},{"metadata":{"name":"other"}}]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	setPriorityListSnapshot(key, snapshot)

	recorder := httptest.NewRecorder()
	if !servePriorityListSnapshot(recorder, req, http.NotFoundHandler()) {
		t.Fatal("expected snapshot response")
	}
	var collection struct {
		Count int               `json:"count"`
		Data  []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &collection); err != nil {
		t.Fatal(err)
	}
	if collection.Count != 2 || len(collection.Data) != 2 {
		t.Fatalf("full snapshot count = %d/%d, want 2/2", collection.Count, len(collection.Data))
	}
}

func TestServePriorityListSnapshotBypassesDeploymentDetailRequests(t *testing.T) {
	resetPriorityListSnapshotsForTest()
	t.Cleanup(resetPriorityListSnapshotsForTest)

	req := httptest.NewRequest(http.MethodGet, "https://exp-dev.example/v1/pods?exclude=metadata.managedFields", nil)
	req.Header.Set("Referer", "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment/test/cxrm-spd#pods")
	key, ok := priorityListSnapshotKey(req)
	if !ok {
		t.Fatal("expected snapshot key")
	}
	prewarmRequest := httptest.NewRequest(http.MethodGet, "http://kube-explorer.local/v1/pods?exclude=metadata.managedFields", nil)
	snapshot, err := preparePriorityListSnapshot(prewarmRequest, cachedListResponse{
		status: http.StatusOK,
		header: http.Header{"Content-Type": []string{"application/json"}},
		body:   []byte(`{"count":1,"data":[{"metadata":{"name":"cxrm-spd-old"}}]}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	setPriorityListSnapshot(key, snapshot)

	recorder := httptest.NewRecorder()
	if servePriorityListSnapshot(recorder, req, http.NotFoundHandler()) {
		t.Fatal("deployment detail request must bypass the priority list snapshot")
	}
	if got := recorder.Header().Get("X-Kube-Explorer-Cache"); got != "" {
		t.Fatalf("cache header = %q, want empty", got)
	}
}

func resetPriorityListSnapshotsForTest() {
	priorityListSnapshots.Lock()
	defer priorityListSnapshots.Unlock()
	priorityListSnapshots.items = map[string]priorityListSnapshot{}
	priorityListSnapshots.refreshing = map[string]bool{}
}
