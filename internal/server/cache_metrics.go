package server

import (
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

var (
	cacheMetricsOnce = sync.Once{}

	listCacheRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "kube_explorer",
		Subsystem: "list_cache",
		Name:      "requests_total",
		Help:      "List requests handled by cache outcome.",
	}, []string{"result"})
	listCacheEvictions = prometheus.NewCounterVec(prometheus.CounterOpts{
		Namespace: "kube_explorer",
		Subsystem: "list_cache",
		Name:      "evictions_total",
		Help:      "List cache entries evicted by reason.",
	}, []string{"reason"})
	listCacheInvalidations = prometheus.NewCounter(prometheus.CounterOpts{
		Namespace: "kube_explorer",
		Subsystem: "list_cache",
		Name:      "invalidations_total",
		Help:      "List cache invalidations after successful writes.",
	})
	listCacheEntries = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: "kube_explorer",
		Subsystem: "list_cache",
		Name:      "entries",
		Help:      "Current number of list cache entries.",
	})
	listCacheBytes = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: "kube_explorer",
		Subsystem: "list_cache",
		Name:      "bytes",
		Help:      "Approximate bytes retained by the list cache.",
	})
	prioritySnapshotRefresh = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Namespace: "kube_explorer",
		Subsystem: "priority_snapshot",
		Name:      "refresh_duration_seconds",
		Help:      "Priority list snapshot refresh duration by path and result.",
		Buckets:   prometheus.DefBuckets,
	}, []string{"path", "result"})
	prioritySnapshotEntries = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: "kube_explorer",
		Subsystem: "priority_snapshot",
		Name:      "entries",
		Help:      "Current number of priority list snapshots.",
	})
	prioritySnapshotBytes = prometheus.NewGauge(prometheus.GaugeOpts{
		Namespace: "kube_explorer",
		Subsystem: "priority_snapshot",
		Name:      "bytes",
		Help:      "Approximate bytes retained by priority list snapshots.",
	})
)

func registerCacheMetrics() {
	cacheMetricsOnce.Do(func() {
		prometheus.MustRegister(
			listCacheRequests,
			listCacheEvictions,
			listCacheInvalidations,
			listCacheEntries,
			listCacheBytes,
			prioritySnapshotRefresh,
			prioritySnapshotEntries,
			prioritySnapshotBytes,
		)
	})
}

func recordListCacheRequest(result string) {
	listCacheRequests.WithLabelValues(result).Inc()
}

func recordListCacheEviction(reason string) {
	listCacheEvictions.WithLabelValues(reason).Inc()
}

func recordListCacheInvalidation() {
	listCacheInvalidations.Inc()
}

func updateListCacheGauges(entries int, bytes int64) {
	listCacheEntries.Set(float64(entries))
	listCacheBytes.Set(float64(bytes))
}

func recordPrioritySnapshotRefresh(path, result string, started time.Time) {
	prioritySnapshotRefresh.WithLabelValues(path, result).Observe(time.Since(started).Seconds())
}

func updatePrioritySnapshotGauges(entries int, bytes int64) {
	prioritySnapshotEntries.Set(float64(entries))
	prioritySnapshotBytes.Set(float64(bytes))
}
