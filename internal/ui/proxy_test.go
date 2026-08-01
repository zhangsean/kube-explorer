package ui

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rancher/apiserver/pkg/urlbuilder"
)

func TestProxyMiddlewareRewritesHTMLLinks(t *testing.T) {
	handler := proxyMiddleware(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(rw, `<a href="/dashboard/next">next</a>`)
	}))
	req := httptest.NewRequest(http.MethodGet, "http://internal/dashboard/", nil)
	req.Header.Set(urlbuilder.ForwardedHostHeader, "public.example")
	req.Header.Set(urlbuilder.ForwardedProtoHeader, "https")
	req.Header.Set(urlbuilder.PrefixHeader, "/kube")
	recorder := httptest.NewRecorder()

	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if got := recorder.Body.String(); !strings.Contains(got, `href="https://public.example/kube/dashboard/next"`) {
		t.Fatalf("rewritten HTML = %q", got)
	}
}

func TestProxyMiddlewareStreamsFlushedResponses(t *testing.T) {
	firstFlushed := make(chan struct{})
	release := make(chan struct{})
	handler := proxyMiddleware(http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) {
		rw.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(rw, "first\n")
		rw.(http.Flusher).Flush()
		close(firstFlushed)
		<-release
		_, _ = io.WriteString(rw, "second\n")
	}))
	req := httptest.NewRequest(http.MethodGet, "http://internal/watch", nil)
	req.Header.Set(urlbuilder.ForwardedHostHeader, "public.example")
	recorder := newStreamingRecorder()
	done := make(chan struct{})
	go func() {
		defer close(done)
		handler.ServeHTTP(recorder, req)
	}()

	select {
	case <-firstFlushed:
	case <-time.After(time.Second):
		t.Fatal("first response chunk was not flushed")
	}
	if got := recorder.bodyString(); got != "first\n" {
		t.Fatalf("body before release = %q", got)
	}
	close(release)
	<-done
	if got := recorder.bodyString(); got != "first\nsecond\n" {
		t.Fatalf("final body = %q", got)
	}
}

func TestResponseToWriterRejectsNilResponse(t *testing.T) {
	if err := responseToWriter(nil, httptest.NewRecorder()); err == nil {
		t.Fatal("expected nil response error")
	}
}

type streamingRecorder struct {
	mu     sync.Mutex
	header http.Header
	status int
	body   strings.Builder
}

func newStreamingRecorder() *streamingRecorder {
	return &streamingRecorder{header: make(http.Header)}
}

func (r *streamingRecorder) Header() http.Header {
	return r.header
}

func (r *streamingRecorder) WriteHeader(status int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status == 0 {
		r.status = status
	}
}

func (r *streamingRecorder) Write(body []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.status == 0 {
		r.status = http.StatusOK
	}
	return r.body.Write(body)
}

func (r *streamingRecorder) Flush() {}

func (r *streamingRecorder) bodyString() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.body.String()
}
