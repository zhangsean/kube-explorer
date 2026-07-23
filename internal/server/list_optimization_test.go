package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOptimizeListRequestsLoadsCompleteWorkloadLists(t *testing.T) {
	tests := []string{
		"/v1/pods?limit=100&exclude=metadata.managedFields",
		"/v1/apps.deployments?limit=100&exclude=metadata.managedFields",
		"/v1/apps.replicasets?limit=100&exclude=metadata.managedFields",
	}

	for _, target := range tests {
		t.Run(target, func(t *testing.T) {
			var downstreamQuery string
			handler := optimizeListRequests(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
				downstreamQuery = req.URL.RawQuery
				rw.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(rw, `{"data":[]}`)
			}))

			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))

			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
			}
			request := httptest.NewRequest(http.MethodGet, "/?"+downstreamQuery, nil)
			if got := request.URL.Query().Get("limit"); got != "" {
				t.Fatalf("downstream limit = %q, want empty", got)
			}
			if got := request.URL.Query().Get("exclude"); got != "metadata.managedFields" {
				t.Fatalf("downstream exclude = %q", got)
			}
		})
	}
}

func TestOptimizeListRequestsPreservesContinuedPage(t *testing.T) {
	var downstreamLimit string
	handler := optimizeListRequests(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		downstreamLimit = req.URL.Query().Get("limit")
		_, _ = io.WriteString(rw, `{"data":[]}`)
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/v1/apps.deployments?limit=100&continue=next-page", nil))

	if downstreamLimit != "100" {
		t.Fatalf("downstream limit = %q, want 100", downstreamLimit)
	}
}

func TestOptimizeListRequestsCachesExpensiveLists(t *testing.T) {
	targets := []string{
		"/v1/apps.deployments?limit=100",
		"/v1/metrics.k8s.io.nodes?exclude=metadata.managedFields",
	}

	for _, target := range targets {
		t.Run(target, func(t *testing.T) {
			cachedListResponses.Lock()
			cachedListResponses.items = map[string]cachedListResponse{}
			cachedListResponses.Unlock()

			calls := 0
			handler := optimizeListRequests(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
				calls++
				rw.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(rw, `{"data":[{"id":"test"}]}`)
			}))

			for i := 0; i < 2; i++ {
				recorder := httptest.NewRecorder()
				handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
				if recorder.Code != http.StatusOK {
					t.Fatalf("request %d status = %d, want %d", i+1, recorder.Code, http.StatusOK)
				}
				if i == 1 && recorder.Header().Get("X-Kube-Explorer-Cache") != "HIT" {
					t.Fatalf("second request cache header = %q, want HIT", recorder.Header().Get("X-Kube-Explorer-Cache"))
				}
			}

			if calls != 1 {
				t.Fatalf("downstream calls = %d, want 1", calls)
			}
		})
	}

	t.Cleanup(func() {
		cachedListResponses.Lock()
		cachedListResponses.items = map[string]cachedListResponse{}
		cachedListResponses.Unlock()
	})
}
