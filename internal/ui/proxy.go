package ui

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/rancher/apiserver/pkg/urlbuilder"
	"k8s.io/apimachinery/pkg/util/proxy"
)

type RoundTripFunc func(*http.Request) (*http.Response, error)

func (r RoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return r(req)
}

func proxyMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		scheme := urlbuilder.GetScheme(r)
		host := urlbuilder.GetHost(r, scheme)
		pathPrepend := r.Header.Get(urlbuilder.PrefixHeader)

		if scheme == r.URL.Scheme && host == r.URL.Host && pathPrepend == "" {
			next.ServeHTTP(w, r)
			return
		}

		var captured *dummyResponseWriter
		proxyRoundtrip := proxy.Transport{
			Scheme:      scheme,
			Host:        host,
			PathPrepend: pathPrepend,
			RoundTripper: RoundTripFunc(func(r *http.Request) (*http.Response, error) {
				captured = &dummyResponseWriter{
					next:   w,
					header: make(http.Header),
				}
				next.ServeHTTP(captured, r)
				return captured.getResponse(r), nil
			}),
		}
		resp, err := proxyRoundtrip.RoundTrip(r)
		if captured != nil && captured.direct {
			return
		}
		if err != nil {
			http.Error(w, "proxy response rewrite failed", http.StatusBadGateway)
			return
		}
		if err := responseToWriter(resp, w); err != nil {
			http.Error(w, "proxy returned an invalid response", http.StatusBadGateway)
		}
	})

}

var _ http.ResponseWriter = &dummyResponseWriter{}
var _ http.Hijacker = &dummyResponseWriter{}

type dummyResponseWriter struct {
	next http.ResponseWriter

	header     http.Header
	body       bytes.Buffer
	statusCode int
	direct     bool
	hijacked   bool
}

// Hijack implements http.Hijacker.
func (drw *dummyResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := drw.next.(http.Hijacker); ok {
		drw.direct = true
		drw.hijacked = true
		return h.Hijack()
	}
	return nil, nil, fmt.Errorf("response writer does not support hijacking")
}

// Header implements the http.ResponseWriter interface.
func (drw *dummyResponseWriter) Header() http.Header {
	return drw.header
}

// Write implements the http.ResponseWriter interface.
func (drw *dummyResponseWriter) Write(b []byte) (int, error) {
	if drw.statusCode == 0 {
		drw.statusCode = http.StatusOK
	}
	if !drw.direct && drw.shouldWriteDirect(b) {
		drw.startDirect()
	}
	if drw.direct {
		return drw.next.Write(b)
	}
	return drw.body.Write(b)
}

// WriteHeader implements the http.ResponseWriter interface.
func (drw *dummyResponseWriter) WriteHeader(statusCode int) {
	if drw.statusCode != 0 {
		return
	}
	drw.statusCode = statusCode
	if statusCode == http.StatusSwitchingProtocols || statusCode == http.StatusNoContent {
		drw.startDirect()
	}
}

func (drw *dummyResponseWriter) Flush() {
	if drw.statusCode == 0 {
		drw.statusCode = http.StatusOK
	}
	drw.startDirect()
	_ = http.NewResponseController(drw.next).Flush()
}

func (drw *dummyResponseWriter) Unwrap() http.ResponseWriter {
	return drw.next
}

func (drw *dummyResponseWriter) Push(target string, options *http.PushOptions) error {
	if pusher, ok := drw.next.(http.Pusher); ok {
		return pusher.Push(target, options)
	}
	return http.ErrNotSupported
}

func (drw *dummyResponseWriter) shouldWriteDirect(body []byte) bool {
	if drw.statusCode >= http.StatusMultipleChoices && drw.statusCode < http.StatusBadRequest {
		return false
	}
	contentType := strings.TrimSpace(strings.SplitN(drw.header.Get("Content-Type"), ";", 2)[0])
	if contentType == "" && len(body) > 0 {
		contentType = strings.TrimSpace(strings.SplitN(http.DetectContentType(body), ";", 2)[0])
		drw.header.Set("Content-Type", contentType)
	}
	return contentType != "" && contentType != "text/html"
}

func (drw *dummyResponseWriter) startDirect() {
	if drw.direct || drw.hijacked {
		return
	}
	copyResponseHeader(drw.next.Header(), drw.header)
	drw.next.WriteHeader(drw.GetStatusCode())
	drw.direct = true
	if drw.body.Len() > 0 {
		_, _ = drw.next.Write(drw.body.Bytes())
		drw.body.Reset()
	}
}

// GetStatusCode returns the status code written to the response.
func (drw *dummyResponseWriter) GetStatusCode() int {
	if drw.statusCode == 0 {
		return 200
	}
	return drw.statusCode
}

func (drw *dummyResponseWriter) getResponse(req *http.Request) *http.Response {
	return &http.Response{
		Status:     strconv.Itoa(drw.GetStatusCode()),
		StatusCode: drw.GetStatusCode(),
		Proto:      "HTTP/1.1",
		ProtoMajor: 1,
		ProtoMinor: 1,
		Request:    req,
		Header:     drw.header,
		Body:       io.NopCloser(&drw.body),
	}
}

func responseToWriter(resp *http.Response, writer http.ResponseWriter) error {
	if resp == nil {
		return fmt.Errorf("nil proxy response")
	}
	defer resp.Body.Close()
	copyResponseHeader(writer.Header(), resp.Header)
	writer.WriteHeader(resp.StatusCode)
	_, err := io.Copy(writer, resp.Body)
	return err
}

func copyResponseHeader(dst, src http.Header) {
	for key, values := range src {
		dst.Del(key)
		for _, value := range values {
			dst.Add(key, value)
		}
	}
}
