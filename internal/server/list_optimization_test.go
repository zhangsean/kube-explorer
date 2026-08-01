package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOptimizeListRequestsPrioritizesFilteredDeploymentResources(t *testing.T) {
	tests := []struct {
		target string
		fields []string
	}{
		{
			target: "/v1/apps.deployments?limit=100&exclude=metadata.managedFields",
			fields: []string{
				"metadata.name",
				"metadata.namespace",
				"spec.template.spec.containers.image",
				"spec.template.spec.initContainers.image",
			},
		},
		{
			target: "/v1/apps.replicasets?limit=100&exclude=metadata.managedFields",
			fields: []string{
				"metadata.name",
				"metadata.namespace",
				"spec.template.spec.containers.image",
				"spec.template.spec.initContainers.image",
			},
		},
		{
			target: "/v1/pods?limit=100&exclude=metadata.managedFields",
			fields: []string{
				"metadata.name",
				"metadata.namespace",
				"spec.containers.image",
				"spec.initContainers.image",
			},
		},
	}

	for _, test := range tests {
		t.Run(test.target, func(t *testing.T) {
			var downstreamQuery string
			handler := optimizeListRequests(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
				downstreamQuery = req.URL.RawQuery
				rw.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(rw, `{"data":[]}`)
			}), false)

			request := httptest.NewRequest(http.MethodGet, test.target, nil)
			request.Header.Set("Referer", "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment?q=v4")
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if got := recorder.Header().Get("X-Kube-Explorer-List-Filter"); got != "priority" {
				t.Fatalf("priority filter header = %q, want priority", got)
			}
			query := httptest.NewRequest(http.MethodGet, "/?"+downstreamQuery, nil).URL.Query()
			if got := query.Get("limit"); got != "" {
				t.Fatalf("downstream limit = %q, want empty", got)
			}
			wantFilter := make([]string, 0, len(test.fields))
			for _, field := range test.fields {
				wantFilter = append(wantFilter, field+"=v4")
			}
			if got, want := query.Get("filter"), strings.Join(wantFilter, ","); got != want {
				t.Fatalf("downstream filter = %q, want %q", got, want)
			}
		})
	}
}

func TestOptimizeListRequestsUsesPriorityFilterHeaderDuringInitialLoad(t *testing.T) {
	var downstreamQuery string
	handler := optimizeListRequests(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		downstreamQuery = req.URL.RawQuery
		rw.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(rw, `{"data":[]}`)
	}), false)

	request := httptest.NewRequest(http.MethodGet, "/v1/apps.deployments?limit=100", nil)
	request.Header.Set("Referer", "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment")
	request.Header.Set("X-Kube-Explorer-List-Filter-Keyword", "v4")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if got := recorder.Header().Get("X-Kube-Explorer-List-Filter"); got != "priority" {
		t.Fatalf("priority filter header = %q, want priority", got)
	}
	query := httptest.NewRequest(http.MethodGet, "/?"+downstreamQuery, nil).URL.Query()
	if got := query.Get("filter"); !strings.Contains(got, "metadata.name=v4") {
		t.Fatalf("downstream filter = %q, want metadata.name=v4", got)
	}
	if got := query.Get("limit"); got != "" {
		t.Fatalf("downstream limit = %q, want empty", got)
	}
}

func TestOptimizeListRequestsDoesNotPrioritizeUnrelatedOrUnsafeFilters(t *testing.T) {
	tests := []struct {
		name     string
		referrer string
		target   string
		header   string
	}{
		{
			name:     "no keyword",
			referrer: "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment",
			target:   "/v1/apps.deployments?exclude=metadata.managedFields",
		},
		{
			name:     "different resource page",
			referrer: "https://exp-dev.example/dashboard/c/local/explorer/apps.statefulset?q=v4",
			target:   "/v1/apps.deployments?exclude=metadata.managedFields",
		},
		{
			name:     "resource detail page",
			referrer: "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment/default/v4-api?q=v4",
			target:   "/v1/apps.deployments?exclude=metadata.managedFields",
		},
		{
			name:     "filter expression characters",
			referrer: "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment?q=v4%2Cmetadata.namespace%3Ddefault",
			target:   "/v1/apps.deployments?exclude=metadata.managedFields",
		},
		{
			name:     "unsafe priority header",
			referrer: "https://exp-dev.example/dashboard/c/local/explorer/apps.deployment",
			target:   "/v1/apps.deployments?exclude=metadata.managedFields",
			header:   "v4,metadata.namespace=default",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var downstreamFilter string
			handler := optimizeListRequests(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
				downstreamFilter = req.URL.Query().Get("filter")
				_, _ = io.WriteString(rw, `{"data":[]}`)
			}), false)

			request := httptest.NewRequest(http.MethodGet, test.target, nil)
			request.Header.Set("Referer", test.referrer)
			request.Header.Set("X-Kube-Explorer-List-Filter-Keyword", test.header)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if downstreamFilter != "" {
				t.Fatalf("downstream filter = %q, want empty", downstreamFilter)
			}
			if got := recorder.Header().Get("X-Kube-Explorer-List-Filter"); got != "" {
				t.Fatalf("priority filter header = %q, want empty", got)
			}
		})
	}
}

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
			}), false)

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
	}), false)

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
			}), false)

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

func TestOptimizeListRequestsDoesNotCacheHTML(t *testing.T) {
	cachedListResponses.Lock()
	cachedListResponses.items = map[string]cachedListResponse{}
	cachedListResponses.Unlock()

	calls := 0
	handler := optimizeListRequests(http.HandlerFunc(func(rw http.ResponseWriter, req *http.Request) {
		calls++
		if calls == 1 {
			rw.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.WriteString(rw, `<!doctype html><title>API browser</title>`)
			return
		}

		rw.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(rw, `{"data":[{"id":"pod-1"}]}`)
	}), false)

	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/v1/pods?exclude=metadata.managedFields", nil))
	if got := first.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("first response content type = %q, want HTML", got)
	}

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/v1/pods?exclude=metadata.managedFields", nil))
	if got := second.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("second response content type = %q, want JSON", got)
	}
	if got := second.Header().Get("X-Kube-Explorer-Cache"); got != "" {
		t.Fatalf("second response cache header = %q, want empty", got)
	}
	if calls != 2 {
		t.Fatalf("downstream calls = %d, want 2", calls)
	}

	t.Cleanup(func() {
		cachedListResponses.Lock()
		cachedListResponses.items = map[string]cachedListResponse{}
		cachedListResponses.Unlock()
	})
}
