(function() {
    'use strict';

    const CONFIG = {
        resourceType: 'pod',
        columns: [
            { key: 'cpuUsage', label: 'CPU', width: '120px' },
            { key: 'memoryUsage', label: 'RAM', width: '120px' }
        ]
    };

    let observer = null;
    let sortState = { key: '', asc: false };
    let metricsCache = {};
    let podResourcesCache = {};
    let nodeResourceSummaryCache = {};
    let lastFetchTime = 0;
    let lastNodeFetchTime = 0;
    const CACHE_DURATION = 3000;
    let processTimer = null;

    function injectStyles() {
        if (document.getElementById('custom-pod-metrics-styles')) return;

        const style = document.createElement('style');
        style.id = 'custom-pod-metrics-styles';
        style.textContent = `
            .metrics-progress-container {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                gap: 3px;
                min-width: 170px;
            }

            .metrics-main-line {
                display: flex;
                align-items: center;
                gap: 8px;
                width: 100%;
            }

            .metrics-progress-bar {
                width: 82px;
                height: 14px;
                background-color: #c7ccd8;
                border-radius: 3px;
                overflow: hidden;
                position: relative;
                display: block;
                direction: ltr;
                text-align: left;
                padding: 0 !important;
            }

            .metrics-progress-fill {
                position: absolute;
                left: 0;
                top: 0;
                bottom: 0;
                height: 100%;
                margin: 0 !important;
                border-radius: 3px;
                transition: width 0.3s ease;
                background: #5f9fd6;
                transform: none !important;
            }

            .metrics-progress-fill.limit-warning {
                background: #e53935;
            }

            .metrics-value {
                min-width: 42px;
                font-weight: 500;
                color: #2f3640;
                font-size: 13px;
            }

            .metrics-request-limit {
                font-size: 11px;
                color: #8a93a3;
                margin-left: 2px;
                white-space: nowrap;
            }

            .metrics-sortable .sort {
                display: inline-flex;
                align-items: center;
                margin-left: 2px;
                vertical-align: middle;
                line-height: 1;
                position: relative;
                top: 0;
            }

            .metrics-sortable .sort .icon-stack {
                display: inline-flex;
                align-items: center;
                height: 14px;
            }

            .metrics-sortable .sort .faded {
                opacity: 0.3 !important;
            }

            .node-req-lim-summary {
                margin-top: 6px;
                font-size: 13px;
                line-height: 1.45;
                color: #8a93a3;
                white-space: nowrap;
            }

            .node-req-lim-summary .node-summary-line {
                display: block;
                letter-spacing: 0.1px;
            }

            .node-req-lim-summary .warning {
                color: #e53935;
            }

            .node-inline-summary {
                font-size: 12px;
                line-height: 1.4;
                color: #8a93a3;
                white-space: nowrap;
                display: inline-flex;
                align-items: center;
                position: absolute;
                top: 50%;
                transform: translateY(-50%);
            }

            .node-inline-summary .metric-block {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                min-width: 200px;
                white-space: nowrap;
            }

            .node-inline-summary .metric-block + .metric-block {
                margin-left: 0;
            }

            .node-inline-summary .warning {
                color: #e53935;
            }

            .node-inline-host {
                position: relative;
            }

            .side-menu {
                width: 0 !important;
                min-width: 0 !important;
                max-width: 0 !important;
                flex: 0 0 0 !important;
                overflow: hidden !important;
            }

            .side-nav {
                width: 200px !important;
                min-width: 200px !important;
                max-width: 200px !important;
                flex: 0 0 200px !important;
            }

            .main-content,
            .main-container,
            .main-layout,
            .shell-main,
            .dashboard-content,
            .resource-list-container,
            .with-subheader {
                margin-left: 0 !important;
                padding-left: 0 !important;
                left: auto !important;
                width: auto !important;
            }

            .ember-iframe {
                left: var(--nav-width) !important;
                width: calc(100vw - var(--nav-width)) !important;
            }

            .dashboard-content.pin-bottom {
                grid-template-columns: 200px auto !important;
            }

            .main-layout .outlet {
                padding: 10px !important;
            }
        `;
        document.head.appendChild(style);
    }

    function isPodTable(table) {
        const headers = table.querySelectorAll('th');
        if (!headers.length) return false;
        const headerTexts = Array.from(headers).map(th => (th.textContent || '').trim().toLowerCase());
        const hasName = headerTexts.includes('name');
        const hasReady = headerTexts.includes('ready');
        const hasRestarts = headerTexts.includes('restarts');
        const hasIP = headerTexts.includes('ip');
        const hasNode = headerTexts.includes('node');
        // Restrict to pod-style list tables to avoid deployment list pages.
        return hasName && hasReady && hasRestarts && hasIP && hasNode;
    }

    function findPodTables() {
        const result = [];
        const tables = document.querySelectorAll('table');
        for (let table of tables) {
            if (isPodTable(table)) {
                result.push(table);
            }
        }
        return result;
    }

    function isNodeTable(table) {
        const headers = table.querySelectorAll('th');
        if (!headers.length) return false;
        const headerTexts = Array.from(headers).map(th => (th.textContent || '').trim().toLowerCase());
        const hasName = headerTexts.includes('name');
        const hasOS = headerTexts.includes('os');
        const hasCPU = headerTexts.some((h) => h.startsWith('cpu'));
        const hasRAM = headerTexts.some((h) => h.startsWith('ram'));
        const hasPods = headerTexts.includes('pods');
        return hasName && hasOS && hasCPU && hasRAM && hasPods;
    }

    function findNodeTables() {
        const result = [];
        const tables = document.querySelectorAll('table');
        for (let table of tables) {
            if (isNodeTable(table)) {
                result.push(table);
            }
        }
        return result;
    }

    function addCustomColumns(table) {
        if (!table) return;

        const thead = table.querySelector('thead');
        if (!thead) return;

        const headerRow = thead.querySelector('tr');
        if (!headerRow) return;

        const headers = () => Array.from(headerRow.querySelectorAll('th'));
        const findHeaderIndex = (label) => headers().findIndex((th) => ((th.textContent || '').trim().toLowerCase().startsWith(label.toLowerCase())));
        const findMemoryHeaderIndex = () => {
            const all = headers();
            return all.findIndex((th) => {
                const text = ((th.textContent || '').trim().toLowerCase());
                return text.startsWith('ram') || text.startsWith('memory');
            });
        };
        const insertHeaderAt = (index, label, key) => {
            const th = document.createElement('th');
            th.textContent = label;
            th.dataset.columnKey = key;
            th.style.width = colWidthByKey(key);
            th.style.fontWeight = 'normal';
            const all = headers();
            const ref = all[index] || null;
            headerRow.insertBefore(th, ref);
        };
        const insertCellAt = (row, index, key) => {
            const td = document.createElement('td');
            td.className = 'text-left';
            td.dataset.columnKey = key;
            td.style.padding = '8px';
            td.style.verticalAlign = 'middle';
            const tds = Array.from(row.querySelectorAll('td'));
            const ref = tds[index] || null;
            row.insertBefore(td, ref);
        };
        const moveColumn = (fromIndex, toIndex) => {
            if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;
            const rows = table.querySelectorAll('tr');
            rows.forEach((row) => {
                if (row.querySelector('td[colspan]')) return;
                const cells = Array.from(row.children).filter((n) => n.tagName === 'TH' || n.tagName === 'TD');
                if (fromIndex >= cells.length || toIndex >= cells.length) return;
                const cell = cells[fromIndex];
                let refIndex = toIndex;
                if (fromIndex < toIndex) refIndex = toIndex + 1;
                const ref = cells[refIndex] || null;
                row.insertBefore(cell, ref);
            });
        };
        const isGroupRow = (row) => {
            if (row.querySelector('td[colspan]')) return true;
            return row.className && row.className.toLowerCase().includes('group');
        };
        const isPodDataRow = (row) => {
            if (isGroupRow(row)) return false;
            // Pod rows always have a clickable name link.
            return !!row.querySelector('a');
        };

        const restartIndex = findHeaderIndex('Restarts');
        let cpuIndex = findHeaderIndex('CPU');
        let memoryIndex = findMemoryHeaderIndex();
        if (cpuIndex < 0 && restartIndex >= 0) {
            insertHeaderAt(restartIndex + 1, 'CPU', 'cpuUsage');
            cpuIndex = findHeaderIndex('CPU');
        }
        if (memoryIndex < 0) {
            const afterCpu = cpuIndex >= 0 ? cpuIndex + 1 : (restartIndex >= 0 ? restartIndex + 1 : headers().length);
            insertHeaderAt(afterCpu, 'RAM', 'memoryUsage');
            memoryIndex = findMemoryHeaderIndex();
        }
        if (cpuIndex < 0 || memoryIndex < 0) return;

        // Keep metric columns stable after UI mode toggles/re-renders.
        if (restartIndex >= 0) {
            if (cpuIndex !== restartIndex + 1) {
                moveColumn(cpuIndex, restartIndex + 1);
                cpuIndex = findHeaderIndex('CPU');
                memoryIndex = findMemoryHeaderIndex();
            }
            if (memoryIndex !== restartIndex + 2) {
                moveColumn(memoryIndex, restartIndex + 2);
                cpuIndex = findHeaderIndex('CPU');
                memoryIndex = findMemoryHeaderIndex();
            }
        }

        const tbody = table.querySelector('tbody');
        if (tbody) {
            const rows = tbody.querySelectorAll('tr');
            rows.forEach(row => {
                if (isGroupRow(row)) {
                    const groupCell = row.querySelector('td[colspan]');
                    if (groupCell) {
                        groupCell.setAttribute('colspan', String(headers().length));
                    }
                    return;
                }
                if (!isPodDataRow(row)) return;

                const expectedCols = headers().length;
                let rowCells = Array.from(row.querySelectorAll('td'));
                if (rowCells.length < expectedCols) {
                    // Ensure metric columns exist before we bind values; this prevents
                    // shifting/overwriting existing IP/Node cells when metrics render later.
                    if (!row.querySelector('td[data-column-key="cpuUsage"]')) {
                        insertCellAt(row, cpuIndex, 'cpuUsage');
                    }
                    if (!row.querySelector('td[data-column-key="memoryUsage"]')) {
                        insertCellAt(row, memoryIndex, 'memoryUsage');
                    }
                    rowCells = Array.from(row.querySelectorAll('td'));
                }

                CONFIG.columns.forEach(col => {
                    const targetIndex = col.key === 'cpuUsage' ? cpuIndex : memoryIndex;
                    if (targetIndex < 0) return;
                    if (rowCells[targetIndex]) {
                        rowCells[targetIndex].dataset.columnKey = col.key;
                    } else {
                        // Only insert when the row is still structurally shorter than header.
                        if (rowCells.length < expectedCols) {
                            insertCellAt(row, targetIndex, col.key);
                        }
                    }
                });
            });
        }

    }

    function colWidthByKey(key) {
        if (key === 'cpuUsage' || key === 'memoryUsage') return '100px';
        if (key === 'age') return '72px';
        return '';
    }

    function applyPodColumnLayout(table) {
        if (!table) return;
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return;
        const headers = Array.from(headerRow.querySelectorAll('th'));
        const findIdx = (pred) => headers.findIndex((th) => pred(((th.textContent || '').trim().toLowerCase())));
        const cpuIdx = findIdx((t) => t.startsWith('cpu'));
        const ramIdx = findIdx((t) => t.startsWith('ram') || t.startsWith('memory'));
        const ageIdx = findIdx((t) => t.startsWith('age'));

        const setHeaderWidth = (idx, w) => {
            if (idx < 0 || !w) return;
            headers[idx].style.width = w;
            headers[idx].style.minWidth = w;
        };
        setHeaderWidth(cpuIdx, colWidthByKey('cpuUsage'));
        setHeaderWidth(ramIdx, colWidthByKey('memoryUsage'));
        setHeaderWidth(ageIdx, colWidthByKey('age'));

        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.forEach((row) => {
            const cells = row.querySelectorAll('td');
            const setCellWidth = (idx, w) => {
                if (idx < 0 || !w || !cells[idx]) return;
                cells[idx].style.width = w;
                cells[idx].style.minWidth = w;
            };
            setCellWidth(cpuIdx, colWidthByKey('cpuUsage'));
            setCellWidth(ramIdx, colWidthByKey('memoryUsage'));
            setCellWidth(ageIdx, colWidthByKey('age'));
        });
    }

    function getHeaderIndexes(table) {
        const result = {};
        if (!table) return result;
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return result;
        const headers = Array.from(headerRow.querySelectorAll('th'));
        headers.forEach((th, index) => {
            const text = (th.textContent || '').trim().toLowerCase();
            if (!text) return;
            if (text.startsWith('restarts') && typeof result.restarts !== 'number') result.restarts = index;
            if (text.startsWith('cpu') && typeof result.cpu !== 'number') result.cpu = index;
            if ((text.startsWith('memory') || text.startsWith('ram')) && typeof result.memory !== 'number') result.memory = index;
        });
        return result;
    }

    function resolveMetricCell(row, key, colIndex) {
        let cell = row.querySelector(`td[data-column-key="${key}"]`);
        if (cell) return cell;

        if (typeof colIndex === 'number' && colIndex >= 0) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells[colIndex]) {
                cell = cells[colIndex];
                cell.dataset.columnKey = key;
                return cell;
            }

            // In grouped mode, some rows can be rendered without CPU/MEM cells
            // after the first group. Patch missing cells in place to keep column alignment.
            if (cells.length > 0 && !row.querySelector('td[colspan]')) {
                const td = document.createElement('td');
                td.className = 'text-left';
                td.dataset.columnKey = key;
                td.style.padding = '8px';
                td.style.verticalAlign = 'middle';
                const ref = cells[colIndex] || null;
                row.insertBefore(td, ref);
                return td;
            }
        }

        return null;
    }

    function parseCPUValue(value) {
        if (!value) return 0;
        value = value.toString().toLowerCase();

        if (value.endsWith('n')) {
            return parseFloat(value.replace('n', '')) / 1000000;
        } else if (value.endsWith('u')) {
            return parseFloat(value.replace('u', '')) / 1000;
        } else if (value.endsWith('m')) {
            return parseFloat(value.replace('m', ''));
        }
        return parseFloat(value) * 1000;
    }

    function parseMemoryValue(value) {
        if (!value) return 0;
        value = value.toString().toLowerCase();

        if (value.endsWith('ki')) {
            return parseFloat(value.replace('ki', '')) / 1024;
        } else if (value.endsWith('mi')) {
            return parseFloat(value.replace('mi', ''));
        } else if (value.endsWith('gi')) {
            return parseFloat(value.replace('gi', '')) * 1024;
        } else if (value.endsWith('ti')) {
            return parseFloat(value.replace('ti', '')) * 1024 * 1024;
        } else if (value.endsWith('k')) {
            return parseFloat(value.replace('k', '')) / 1024;
        } else if (value.endsWith('m')) {
            return parseFloat(value.replace('m', '')) / (1024 * 1024);
        } else if (value.endsWith('g')) {
            return parseFloat(value.replace('g', '')) * 1024;
        }

        const numValue = parseFloat(value);
        if (numValue > 0) {
            return numValue / (1024 * 1024);
        }
        return 0;
    }

    function formatPercent(value) {
        if (!isFinite(value) || value <= 0) return '0%';
        if (value >= 100) return `${Math.round(value)}%`;
        if (value >= 10) return `${value.toFixed(1).replace(/\.0$/, '')}%`;
        return `${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
    }

    function formatCPUCapacity(milliCPU) {
        if (!milliCPU || milliCPU <= 0) return '-';
        const cores = milliCPU / 1000;
        if (cores >= 10 || Math.abs(Math.round(cores) - cores) < 0.001) {
            return `${Math.round(cores)}C`;
        }
        return `${cores.toFixed(1).replace(/\.0$/, '')}C`;
    }

    function formatMemoryCapacity(mi) {
        if (!mi || mi <= 0) return '-';
        const gi = mi / 1024;
        if (gi >= 10 || Math.abs(Math.round(gi) - gi) < 0.01) {
            return `${Math.round(gi)}G`;
        }
        return `${gi.toFixed(1).replace(/\.0$/, '')}G`;
    }

    function getPodResources(pod) {
        const resources = {
            cpu: { request: 0, limit: 0 },
            memory: { request: 0, limit: 0 }
        };

        if (pod.spec && pod.spec.containers) {
            pod.spec.containers.forEach(container => {
                if (container.resources) {
                    if (container.resources.requests) {
                        resources.cpu.request += parseCPUValue(container.resources.requests.cpu || 0);
                        resources.memory.request += parseMemoryValue(container.resources.requests.memory || 0);
                    }
                    if (container.resources.limits) {
                        resources.cpu.limit += parseCPUValue(container.resources.limits.cpu || 0);
                        resources.memory.limit += parseMemoryValue(container.resources.limits.memory || 0);
                    }
                }
            });
        }

        return resources;
    }
    function getPodKeys(pod) {
        const keys = new Set();
        const id = pod && pod.id ? String(pod.id) : '';
        const metadata = pod && pod.metadata ? pod.metadata : {};
        const name = metadata.name ? String(metadata.name) : '';
        const namespace = metadata.namespace ? String(metadata.namespace) : '';

        if (id) keys.add(id);
        if (name) keys.add(name);
        if (namespace && name) {
            keys.add(`${namespace}/${name}`);
            keys.add(`${namespace}:${name}`);
        }

        return Array.from(keys);
    }

    function normalizeKey(key) {
        return (key || '').toString().trim().toLowerCase();
    }

    function extractRowPodKeys(row) {
        const keys = new Set();
        const addKey = (key) => {
            const normalized = normalizeKey(key);
            if (normalized) keys.add(normalized);
        };

        const links = row.querySelectorAll('a[href]');
        links.forEach((link) => {
            addKey(link.textContent);
            const href = link.getAttribute('href') || '';
            const match = href.match(/\/pod\/([^\/?#]+)\/([^\/?#]+)/i);
            if (match) {
                const namespace = decodeURIComponent(match[1]);
                const name = decodeURIComponent(match[2]);
                addKey(name);
                addKey(`${namespace}/${name}`);
                addKey(`${namespace}:${name}`);
            }
        });

        const cells = row.querySelectorAll('td');
        cells.forEach((cell) => addKey(cell.textContent));

        return Array.from(keys);
    }

    async function fetchJSON(candidates, endpointName) {
        let lastError = null;
        for (const url of candidates) {
            try {
                const resp = await fetch(url, {
                    headers: { 'Accept': 'application/json' },
                    credentials: 'same-origin'
                });
                if (!resp.ok) {
                    lastError = new Error(`${url} status ${resp.status}`);
                    continue;
                }

                const contentType = (resp.headers.get('content-type') || '').toLowerCase();
                const raw = await resp.text();
                if (!contentType.includes('application/json')) {
                    const preview = raw.slice(0, 120).replace(/\s+/g, ' ');
                    lastError = new Error(`${url} returned non-json content-type=${contentType}, body=${preview}`);
                    continue;
                }

                return JSON.parse(raw);
            } catch (e) {
                lastError = e;
            }
        }

        throw lastError || new Error(`no ${endpointName} endpoint available`);
    }

    async function fetchPodsJSON() {
        return fetchJSON([
            // '/k8s/clusters/local/v1/pods?exclude=metadata.managedFields',
            '/v1/pods?exclude=metadata.managedFields',
        ], 'pods');
    }

    async function fetchNodesJSON() {
        return fetchJSON([
            '/v1/nodes?exclude=metadata.managedFields',
        ], 'nodes');
    }

    async function fetchPodMetricsJSON() {
        return fetchJSON([
            // '/k8s/clusters/local/v1/metrics.k8s.io.pods?exclude=metadata.managedFields',
            '/v1/metrics.k8s.io.pods?exclude=metadata.managedFields',
        ], 'pod metrics');
    }

    function getNodeResourceCapacity(node) {
        const allocatable = (node && node.status && node.status.allocatable) || {};
        const capacity = (node && node.status && node.status.capacity) || {};
        const cpuRaw = allocatable.cpu || capacity.cpu || 0;
        const memoryRaw = allocatable.memory || capacity.memory || 0;
        return {
            cpuMilli: parseCPUValue(cpuRaw),
            memoryMi: parseMemoryValue(memoryRaw)
        };
    }

    async function fetchNodeResourceSummary() {
        const now = Date.now();
        if (now - lastNodeFetchTime < CACHE_DURATION && Object.keys(nodeResourceSummaryCache).length > 0) {
            return nodeResourceSummaryCache;
        }

        try {
            const [nodesData, podsData] = await Promise.all([fetchNodesJSON(), fetchPodsJSON()]);
            const nodes = nodesData.data || [];
            const pods = podsData.data || [];
            const summary = {};

            nodes.forEach((node) => {
                const name = normalizeKey(node && node.metadata && node.metadata.name);
                if (!name) return;
                const cap = getNodeResourceCapacity(node);
                summary[name] = {
                    cpuTotal: cap.cpuMilli,
                    memoryTotal: cap.memoryMi,
                    cpuRequest: 0,
                    cpuLimit: 0,
                    memoryRequest: 0,
                    memoryLimit: 0
                };
            });

            pods.forEach((pod) => {
                const nodeName = normalizeKey(pod && pod.spec && pod.spec.nodeName);
                if (!nodeName || !summary[nodeName]) return;
                const resources = getPodResources(pod);
                summary[nodeName].cpuRequest += resources.cpu.request;
                summary[nodeName].cpuLimit += resources.cpu.limit;
                summary[nodeName].memoryRequest += resources.memory.request;
                summary[nodeName].memoryLimit += resources.memory.limit;
            });

            nodeResourceSummaryCache = summary;
            lastNodeFetchTime = now;
            return summary;
        } catch (error) {
            console.error('Failed to fetch node resource summary:', error);
            return null;
        }
    }

    function buildMetricsEntry(item) {
        if (item && item.cpuUsage && item.memoryUsage) {
            const cpuUsageValue = parseCPUValue(item.cpuUsage || 0);
            const memoryUsageValue = parseMemoryValue(item.memoryUsage || 0);
            return {
                cpuUsage: cpuUsageValue > 0 ? `${Math.round(cpuUsageValue)}m` : '-',
                memoryUsage: memoryUsageValue > 0 ? `${Math.round(memoryUsageValue)}Mi` : '-',
                cpuUsageValue: cpuUsageValue,
                memoryUsageValue: memoryUsageValue
            };
        }

        const containers = (item && item.containers) || [];
        let totalCPU = 0;
        let totalMemory = 0;
        containers.forEach(container => {
            const usage = container && container.usage ? container.usage : {};
            totalCPU += parseCPUValue(usage.cpu || 0);
            totalMemory += parseMemoryValue(usage.memory || 0);
        });
        return {
            cpuUsage: totalCPU > 0 ? `${Math.round(totalCPU)}m` : '-',
            memoryUsage: totalMemory > 0 ? `${Math.round(totalMemory)}Mi` : '-',
            cpuUsageValue: totalCPU,
            memoryUsageValue: totalMemory
        };
    }

    async function fetchPodMetrics() {
        const now = Date.now();
        if (now - lastFetchTime < CACHE_DURATION && Object.keys(metricsCache).length > 0) {
            return { metrics: metricsCache, resources: podResourcesCache };
        }

        try {
            const podsData = await fetchPodsJSON();
            const pods = podsData.data || [];
            const podMetricsData = await fetchPodMetricsJSON();
            const podMetrics = podMetricsData.data || [];

            podResourcesCache = {};
            metricsCache = {};

            pods.forEach((pod) => {
                const keys = getPodKeys(pod);
                const resources = getPodResources(pod);

                const resourcesEntry = {
                    cpuRequest: resources.cpu.request,
                    cpuLimit: resources.cpu.limit,
                    memoryRequest: resources.memory.request,
                    memoryLimit: resources.memory.limit
                };

                keys.forEach((key) => {
                    podResourcesCache[normalizeKey(key)] = resourcesEntry;
                });
            });

            podMetrics.forEach((item) => {
                const keys = getPodKeys(item);
                const metricsEntry = buildMetricsEntry(item);
                keys.forEach((key) => {
                    metricsCache[normalizeKey(key)] = metricsEntry;
                });
            });

            lastFetchTime = now;
            return { metrics: metricsCache, resources: podResourcesCache };
        } catch (error) {
            console.error('Failed to fetch pod metrics:', error);
            return null;
        }
    }
    function calculateUsagePercentage(usage, request, limit) {
        if (limit > 0) {
            return (usage / limit) * 100;
        } else if (request > 0) {
            return (usage / request) * 100;
        }
        return 0;
    }

    function createProgressBar(usage, request, limit, unit) {
        const container = document.createElement('div');
        container.className = 'metrics-progress-container';

        const percentage = calculateUsagePercentage(usage, request, limit);
        const limitPercentage = limit > 0 ? (usage / limit) * 100 : 0;
        const mainLine = document.createElement('div');
        mainLine.className = 'metrics-main-line';
        const barContainer = document.createElement('div');
        barContainer.className = 'metrics-progress-bar';

        const fill = document.createElement('div');
        fill.className = 'metrics-progress-fill';
        if (limit > 0 && limitPercentage >= 90) {
            fill.classList.add('limit-warning');
        }
        fill.style.width = `${Math.min(percentage, 100)}%`;

        const value = document.createElement('span');
        value.className = 'metrics-value';
        value.textContent = `${Math.round(usage)}${unit}`;

        const requestLimit = document.createElement('span');
        requestLimit.className = 'metrics-request-limit';
        const parts = [];
        if (request > 0) {
            parts.push(`Req ${Math.round(request)}${unit}`);
        }
        if (limit > 0) {
            parts.push(`Lim ${Math.round(limit)}${unit}`);
        }
        requestLimit.textContent = parts.length > 0 ? parts.join(' / ') : '-';

        barContainer.appendChild(fill);
        mainLine.appendChild(barContainer);
        mainLine.appendChild(value);
        container.appendChild(mainLine);
        container.appendChild(requestLimit);

        return container;
    }

    function getRowMetricValue(row, key, metrics) {
        const rowKeys = extractRowPodKeys(row);
        for (const k of rowKeys) {
            const entry = metrics && metrics[k];
            if (entry) {
                return key === 'cpuUsage' ? (entry.cpuUsageValue || 0) : (entry.memoryUsageValue || 0);
            }
        }
        return 0;
    }

    function sortRowsByMetric(table, key, asc, metrics) {
        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
            const av = getRowMetricValue(a, key, metrics);
            const bv = getRowMetricValue(b, key, metrics);
            return asc ? av - bv : bv - av;
        });
        rows.forEach((row) => tbody.appendChild(row));
    }

    function ensureSortIcon(th) {
        let sortRoot = th.querySelector('.sort.metrics-sort-indicator');
        if (sortRoot) {
            return {
                root: sortRoot,
                up: sortRoot.querySelector('.icon-sort'),
                down: sortRoot.querySelector('.icon-sort-down'),
            };
        }

        sortRoot = document.createElement('div');
        sortRoot.className = 'sort metrics-sort-indicator';

        const info = document.createElement('i');
        info.className = 'icon icon-info not-filter-icon has-tooltip';
        info.style.display = 'none';

        const stack = document.createElement('span');
        stack.className = 'icon-stack';

        const up = document.createElement('i');
        up.className = 'icon icon-sort icon-stack-1x faded';

        const down = document.createElement('i');
        down.className = 'icon icon-sort-down icon-stack-1x faded';

        stack.appendChild(up);
        stack.appendChild(down);
        sortRoot.appendChild(info);
        sortRoot.appendChild(stack);
        th.appendChild(sortRoot);

        return { root: sortRoot, up, down };
    }

    function applySortVisual(th, key) {
        const icon = ensureSortIcon(th);
        if (!icon.up || !icon.down) return;

        icon.up.classList.add('faded');
        icon.down.classList.add('faded');

        if (sortState.key !== key) {
            return;
        }

        if (sortState.asc) {
            icon.up.classList.remove('faded');
        } else {
            icon.down.classList.remove('faded');
        }
    }

    function resetAllSortIcons(headerRow) {
        const upIcons = headerRow.querySelectorAll('.sort .icon-sort');
        const downIcons = headerRow.querySelectorAll('.sort .icon-sort-down');
        upIcons.forEach((el) => el.classList.add('faded'));
        downIcons.forEach((el) => el.classList.add('faded'));
    }

    function enableMetricSorting(table) {
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return;

        const headers = Array.from(headerRow.querySelectorAll('th'));
        if (sortState.key) {
            // When metric sorting is enabled, clear active arrows from all columns
            // (including Name default sort) first.
            resetAllSortIcons(headerRow);
        }
        headers.forEach((th) => {
            const text = (th.textContent || '').trim().toLowerCase();
            const key = text.startsWith('cpu') ? 'cpuUsage' : ((text.startsWith('memory') || text.startsWith('ram')) ? 'memoryUsage' : '');
            if (!key) return;

            th.classList.add('metrics-sortable');
            // Ensure metric columns always have native sort widget and default
            // inactive style before applying current metric sort state.
            ensureSortIcon(th);
            if (!th.dataset.sortBound) {
                th.addEventListener('click', () => {
                    if (sortState.key === key) {
                        sortState.asc = !sortState.asc;
                    } else {
                        sortState.key = key;
                        sortState.asc = false;
                    }
                    sortRowsByMetric(table, sortState.key, sortState.asc, metricsCache);
                    enableMetricSorting(table);
                });
                th.dataset.sortBound = '1';
            }
            applySortVisual(th, key);
        });
    }

    function updateTableWithMetrics(table, data) {
        if (!data) return;

        const { metrics, resources } = data;
        const headerIndexes = getHeaderIndexes(table);
        const cpuIndex = typeof headerIndexes.cpu === 'number' ? headerIndexes.cpu : -1;
        const memoryIndex = typeof headerIndexes.memory === 'number' ? headerIndexes.memory : -1;
        const expectedCols = table.querySelectorAll('thead tr th').length;

        const tbody = table.querySelector('tbody');
        if (!tbody) return;

        const rows = tbody.querySelectorAll('tr');
        rows.forEach(row => {
            const singleCol = row.querySelector('td[colspan]');
            if (singleCol) return;

            // Normalize row column count before mapping indexes; this prevents
            // IP/Node cells from being mistaken as CPU/MEM after grouped mode toggles.
            const existingMetricCPU = row.querySelector('td[data-column-key="cpuUsage"]');
            const existingMetricMem = row.querySelector('td[data-column-key="memoryUsage"]');
            let rowCells = Array.from(row.querySelectorAll('td'));
            if (rowCells.length < expectedCols) {
                if (!existingMetricCPU && cpuIndex >= 0) {
                    const td = document.createElement('td');
                    td.className = 'text-left';
                    td.dataset.columnKey = 'cpuUsage';
                    td.style.padding = '8px';
                    td.style.verticalAlign = 'middle';
                    const ref = rowCells[cpuIndex] || null;
                    row.insertBefore(td, ref);
                }
                rowCells = Array.from(row.querySelectorAll('td'));
                if (!existingMetricMem && memoryIndex >= 0) {
                    const td = document.createElement('td');
                    td.className = 'text-left';
                    td.dataset.columnKey = 'memoryUsage';
                    td.style.padding = '8px';
                    td.style.verticalAlign = 'middle';
                    const ref = rowCells[memoryIndex] || null;
                    row.insertBefore(td, ref);
                }
            }

            const rowKeys = extractRowPodKeys(row);
            if (rowKeys.length === 0) return;

            let podMetrics = null;
            let podResources = null;
            rowKeys.some((key) => {
                if (!podMetrics && metrics && metrics[key]) {
                    podMetrics = metrics[key];
                }
                if (!podResources && resources && resources[key]) {
                    podResources = resources[key];
                }
                return podMetrics && podResources;
            });

            CONFIG.columns.forEach(col => {
                const colIndex = col.key === 'cpuUsage' ? cpuIndex : memoryIndex;
                const cell = resolveMetricCell(row, col.key, colIndex);
                if (!cell) return;

                cell.innerHTML = '';
                cell.style.background = 'transparent';

                if (col.key === 'cpuUsage') {
                    const cpuUsage = podMetrics ? podMetrics.cpuUsageValue : 0;
                    const cpuRequest = podResources ? podResources.cpuRequest : 0;
                    const cpuLimit = podResources ? podResources.cpuLimit : 0;

                    if (cpuUsage > 0 || cpuRequest > 0 || cpuLimit > 0) {
                        const bar = createProgressBar(
                            cpuUsage,
                            cpuRequest,
                            cpuLimit,
                            'm'
                        );
                        cell.appendChild(bar);
                    } else {
                        cell.textContent = '-';
                    }
                } else if (col.key === 'memoryUsage') {
                    const memoryUsage = podMetrics ? podMetrics.memoryUsageValue : 0;
                    const memoryRequest = podResources ? podResources.memoryRequest : 0;
                    const memoryLimit = podResources ? podResources.memoryLimit : 0;

                    if (memoryUsage > 0 || memoryRequest > 0 || memoryLimit > 0) {
                        const bar = createProgressBar(
                            memoryUsage,
                            memoryRequest,
                            memoryLimit,
                            'Mi'
                        );
                        cell.appendChild(bar);
                    } else {
                        cell.textContent = '-';
                    }
                }
            });
        });
    }

    function getNodeHeaderIndexes(table) {
        const result = {};
        if (!table) return result;
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return result;
        const headers = Array.from(headerRow.querySelectorAll('th'));
        headers.forEach((th, index) => {
            const text = (th.textContent || '').trim().toLowerCase();
            if (!text) return;
            if (text === 'name' && typeof result.name !== 'number') result.name = index;
            if (text.startsWith('version') && typeof result.version !== 'number') result.version = index;
            if (text.startsWith('external/internal ip') && typeof result.ip !== 'number') result.ip = index;
            if (text.startsWith('cpu') && typeof result.cpu !== 'number') result.cpu = index;
            if (text.startsWith('ram') && typeof result.ram !== 'number') result.ram = index;
        });
        return result;
    }

    function applyNodeColumnLayout(table, headerIndexes) {
        if (!table || !headerIndexes) return;
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return;

        const headers = headerRow.querySelectorAll('th');
        const setHeaderWidth = (index, width) => {
            if (typeof index !== 'number' || index < 0 || !headers[index]) return;
            headers[index].style.width = width;
            headers[index].style.minWidth = width;
        };

        // Rebalance Node list columns: shrink Version, slightly widen IP, keep CPU/RAM roomy.
        setHeaderWidth(headerIndexes.version, '170px');
        setHeaderWidth(headerIndexes.ip, '340px');
        setHeaderWidth(headerIndexes.cpu, '200px');
        setHeaderWidth(headerIndexes.ram, '200px');

        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.forEach((row) => {
            const cells = row.querySelectorAll('td');
            const setCellWidth = (index, width) => {
                if (typeof index !== 'number' || index < 0 || !cells[index]) return;
                cells[index].style.width = width;
                cells[index].style.minWidth = width;
            };

            setCellWidth(headerIndexes.version, '170px');
            setCellWidth(headerIndexes.ip, '340px');
            setCellWidth(headerIndexes.cpu, '200px');
            setCellWidth(headerIndexes.ram, '200px');
        });
    }

    function extractNodeNameFromRow(row, nameIndex) {
        const link = row.querySelector('a[href*="/node/"]');
        if (link && link.textContent) {
            return normalizeKey(link.textContent);
        }

        if (typeof nameIndex === 'number' && nameIndex >= 0) {
            const cells = row.querySelectorAll('td');
            if (cells[nameIndex]) {
                return normalizeKey(cells[nameIndex].textContent);
            }
        }
        return '';
    }

    function ensureNodeSummary(container) {
        let summary = container.querySelector('.node-req-lim-summary');
        if (summary) {
            return summary;
        }

        summary = document.createElement('div');
        summary.className = 'node-req-lim-summary';

        const reqLine = document.createElement('span');
        reqLine.className = 'node-summary-line node-req-line';
        const limLine = document.createElement('span');
        limLine.className = 'node-summary-line node-lim-line';

        summary.appendChild(reqLine);
        summary.appendChild(limLine);
        container.appendChild(summary);
        return summary;
    }

    function updateNodeCellSummary(cell, request, limit, total, totalLabel) {
        const summary = ensureNodeSummary(cell);
        const reqLine = summary.querySelector('.node-req-line');
        const limLine = summary.querySelector('.node-lim-line');
        if (!reqLine || !limLine) return;

        const reqPct = total > 0 ? (request / total) * 100 : 0;
        const limPct = total > 0 ? (limit / total) * 100 : 0;

        reqLine.textContent = `Req ${formatPercent(reqPct)}/${totalLabel}`;
        limLine.textContent = `Lim ${formatPercent(limPct)}/${totalLabel}`;

        reqLine.classList.toggle('warning', reqPct > 90);
        limLine.classList.toggle('warning', limPct > 90);
    }

    function clearNodeCellSummary(cell) {
        if (!cell) return;
        const summary = cell.querySelector('.node-req-lim-summary');
        if (summary && summary.parentNode) {
            summary.parentNode.removeChild(summary);
        }
    }

    function findNodeMetaRow(mainRow) {
        let next = mainRow ? mainRow.nextElementSibling : null;
        while (next) {
            if (next.querySelector('a[href*="/node/"]')) return null;
            const text = (next.textContent || '').toLowerCase();
            if (text.includes('taints:') || text.includes('labels:')) return next;
            if (next.querySelector('td[colspan]')) return null;
            next = next.nextElementSibling;
        }
        return null;
    }

    function setWarnClass(el, enabled) {
        if (!el) return;
        el.classList.toggle('warning', !!enabled);
    }

    function updateNodeInlineSummary(metaRow, summary, table, headerIndexes) {
        if (!metaRow || !summary) return;
        const hostCell = Array.from(metaRow.querySelectorAll('td')).find((td) => {
            const text = (td.textContent || '').toLowerCase();
            return text.includes('taints:') || text.includes('labels:');
        });
        if (!hostCell) return;

        let container = hostCell.querySelector('.node-inline-summary');
        if (!container) {
            container = document.createElement('span');
            container.className = 'node-inline-summary';
            container.innerHTML = [
                '<span class="metric-block cpu-block"><span class="cpu-req"></span><span class="cpu-lim"></span><span class="cpu-all"></span></span>',
                '<span class="metric-block ram-block"><span class="mem-req"></span><span class="mem-lim"></span><span class="mem-all"></span></span>'
            ].join('');
            hostCell.appendChild(container);
        }
        hostCell.classList.add('node-inline-host');

        // Align inline CPU/RAM summaries with CPU/RAM columns in the main row.
        const headerRow = table ? table.querySelector('thead tr') : null;
        const headers = headerRow ? headerRow.querySelectorAll('th') : null;
        const cpuHeader = headers && typeof headerIndexes.cpu === 'number' ? headers[headerIndexes.cpu] : null;
        const ramHeader = headers && typeof headerIndexes.ram === 'number' ? headers[headerIndexes.ram] : null;
        if (cpuHeader && ramHeader) {
            const hostRect = hostCell.getBoundingClientRect();
            const cpuRect = cpuHeader.getBoundingClientRect();
            const ramRect = ramHeader.getBoundingClientRect();
            const cpuLeft = Math.max(8, Math.round(cpuRect.left - hostRect.left));
            const gap = Math.max(12, Math.round(ramRect.left - cpuRect.left - 200));
            const cpuBlock = container.querySelector('.cpu-block');
            const ramBlock = container.querySelector('.ram-block');
            container.style.left = `${cpuLeft}px`;
            container.style.marginLeft = '0px';
            if (cpuBlock) cpuBlock.style.minWidth = `${Math.max(180, Math.round(cpuRect.width))}px`;
            if (ramBlock) ramBlock.style.minWidth = `${Math.max(180, Math.round(ramRect.width))}px`;
            if (ramBlock) ramBlock.style.marginLeft = `${gap}px`;
        }

        const cpuReqPct = summary.cpuTotal > 0 ? (summary.cpuRequest / summary.cpuTotal) * 100 : 0;
        const cpuLimPct = summary.cpuTotal > 0 ? (summary.cpuLimit / summary.cpuTotal) * 100 : 0;
        const memReqPct = summary.memoryTotal > 0 ? (summary.memoryRequest / summary.memoryTotal) * 100 : 0;
        const memLimPct = summary.memoryTotal > 0 ? (summary.memoryLimit / summary.memoryTotal) * 100 : 0;

        const cpuTotalLabel = formatCPUCapacity(summary.cpuTotal);
        const memTotalLabel = formatMemoryCapacity(summary.memoryTotal);

        const cpuReq = container.querySelector('.cpu-req');
        const cpuLim = container.querySelector('.cpu-lim');
        const cpuAll = container.querySelector('.cpu-all');
        const memReq = container.querySelector('.mem-req');
        const memLim = container.querySelector('.mem-lim');
        const memAll = container.querySelector('.mem-all');

        if (cpuReq) cpuReq.textContent = `Req ${formatPercent(cpuReqPct)}`;
        if (cpuLim) cpuLim.textContent = `Lim ${formatPercent(cpuLimPct)}`;
        if (cpuAll) cpuAll.textContent = `All ${cpuTotalLabel}`;
        if (memReq) memReq.textContent = `Req ${formatPercent(memReqPct)}`;
        if (memLim) memLim.textContent = `Lim ${formatPercent(memLimPct)}`;
        if (memAll) memAll.textContent = `All ${memTotalLabel}`;

        setWarnClass(cpuReq, cpuReqPct > 90);
        setWarnClass(cpuLim, cpuLimPct > 90);
        setWarnClass(memReq, memReqPct > 90);
        setWarnClass(memLim, memLimPct > 90);
    }

    function updateNodeTableWithResources(table, summaryMap) {
        if (!table || !summaryMap) return;
        const headerIndexes = getNodeHeaderIndexes(table);
        const cpuIndex = typeof headerIndexes.cpu === 'number' ? headerIndexes.cpu : -1;
        const ramIndex = typeof headerIndexes.ram === 'number' ? headerIndexes.ram : -1;
        const nameIndex = typeof headerIndexes.name === 'number' ? headerIndexes.name : 1;
        if (cpuIndex < 0 && ramIndex < 0) return;
        applyNodeColumnLayout(table, headerIndexes);

        const tbody = table.querySelector('tbody');
        if (!tbody) return;

        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.forEach((row) => {
            if (row.querySelector('td[colspan]')) return;
            const nodeName = extractNodeNameFromRow(row, nameIndex);
            if (!nodeName) return;
            const summary = summaryMap[nodeName];
            if (!summary) return;

            const cells = row.querySelectorAll('td');
            if (cpuIndex >= 0 && cells[cpuIndex]) {
                clearNodeCellSummary(cells[cpuIndex]);
            }
            if (ramIndex >= 0 && cells[ramIndex]) {
                clearNodeCellSummary(cells[ramIndex]);
            }

            const metaRow = findNodeMetaRow(row);
            if (metaRow) {
                updateNodeInlineSummary(metaRow, summary, table, headerIndexes);
            }
        });
    }

    async function processPodsPage() {
        const tables = findPodTables();
        if (!tables.length) return;

        const data = await fetchPodMetrics();
        tables.forEach((table) => {
            addCustomColumns(table);
            applyPodColumnLayout(table);
            if (data) {
                updateTableWithMetrics(table, data);
                if (sortState.key) {
                    sortRowsByMetric(table, sortState.key, sortState.asc, data.metrics);
                }
                enableMetricSorting(table);
            }
        });
    }

    async function processNodesPage() {
        const tables = findNodeTables();
        if (!tables.length) return;

        const summary = await fetchNodeResourceSummary();
        if (!summary) return;
        tables.forEach((table) => {
            updateNodeTableWithResources(table, summary);
        });
    }

    function scheduleProcess(delay = 50) {
        if (processTimer) {
            clearTimeout(processTimer);
        }
        processTimer = setTimeout(() => {
            processTimer = null;
            processPodsPage();
            processNodesPage();
        }, delay);
    }

    function observeChanges() {
        if (observer) {
            observer.disconnect();
        }

        observer = new MutationObserver((mutations) => {
            for (let mutation of mutations) {
                if (mutation.type !== 'childList' || mutation.addedNodes.length === 0) {
                    continue;
                }
                scheduleProcess(80);
                break;
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function init() {
        injectStyles();

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                scheduleProcess(100);
                observeChanges();
            });
        } else {
            scheduleProcess(100);
            observeChanges();
        }

        window.addEventListener('popstate', () => {
            scheduleProcess(100);
        });

        const originalPushState = history.pushState;
        history.pushState = function() {
            originalPushState.apply(this, arguments);
            scheduleProcess(100);
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function() {
            originalReplaceState.apply(this, arguments);
            scheduleProcess(200);
        };

        setInterval(() => {
            processPodsPage();
            processNodesPage();
        }, 5000);
    }

    init();
})();

