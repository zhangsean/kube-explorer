package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOperationalEndpoints(t *testing.T) {
	readiness := &serverReadiness{}
	handler := operationalEndpoints(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.WriteHeader(http.StatusTeapot)
	}), readiness)

	for _, path := range []string{"/healthz", "/livez"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != http.StatusOK || strings.TrimSpace(recorder.Body.String()) != "ok" {
			t.Fatalf("%s response = %d %q", path, recorder.Code, recorder.Body.String())
		}
	}

	notReady := httptest.NewRecorder()
	handler.ServeHTTP(notReady, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if notReady.Code != http.StatusServiceUnavailable {
		t.Fatalf("not-ready status = %d", notReady.Code)
	}

	readiness.ready.Store(true)
	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK || strings.TrimSpace(ready.Body.String()) != "ready" {
		t.Fatalf("ready response = %d %q", ready.Code, ready.Body.String())
	}

	fallback := httptest.NewRecorder()
	handler.ServeHTTP(fallback, httptest.NewRequest(http.MethodGet, "/dashboard/", nil))
	if fallback.Code != http.StatusTeapot {
		t.Fatalf("fallback status = %d", fallback.Code)
	}
}

func TestMetricsEndpointIncludesCacheMetrics(t *testing.T) {
	handler := operationalEndpoints(http.NotFoundHandler(), &serverReadiness{})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("metrics status = %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "kube_explorer_list_cache_entries") {
		t.Fatal("cache metrics were not exposed")
	}
}
