(function(root, factory) {
    'use strict';

    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.KubeExplorerPriorityLists = api;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';

    const FILTER_HEADER = 'X-Kube-Explorer-List-Filter-Keyword';
    const REQUEST_PATHS = new Set([
        '/v1/apps.deployments',
        '/v1/apps.replicasets',
        '/v1/pods'
    ]);
    const REQUEST_MAX_WAIT = 2000;
    const INPUT_GRACE = 350;
    const INPUT_SETTLE = 200;

    function normalizeFilterKeyword(value) {
        const keyword = String(value || '').trim();
        return /^[A-Za-z0-9._:/@-]{1,128}$/.test(keyword) ? keyword : '';
    }

    function create(options) {
        const win = options.window;
        const doc = options.document;
        const pendingRequests = new Set();
        const activeRequests = new Map();
        const boundInputs = new WeakSet();
        let inputFlushTimer = null;
        let reloadTimer = null;
        let reloadInProgress = false;
        let reloadRequested = false;
        let loadedKeyword = null;
        let activeKeyword = null;
        let requestKeywordOverride = null;
        let relatedRestorePromise = null;
        let staleTbodies = [];
        let staleTable = null;
        let staleObserver = null;

        function isDeploymentListPage(value) {
            return options.getListedResource(value || win.location.href) === 'apps.deployment';
        }

        function findFilterInput() {
            if (!isDeploymentListPage()) return null;
            return doc.querySelector(
                '[data-testid="search-box-filter-row"] input[type="search"], .fixed-header-actions input[type="search"]'
            );
        }

        function getKeyword() {
            const input = findFilterInput();
            if (input) return normalizeFilterKeyword(input.value);
            const url = options.parseDashboardUrl(win.location.href);
            return normalizeFilterKeyword(url ? url.searchParams.get('q') : '');
        }

        function sendRequest(xhr, originalSend, sendArgs) {
            const keyword = requestKeywordOverride === null ? getKeyword() : requestKeywordOverride;
            xhr.setRequestHeader(FILTER_HEADER, keyword);
            if (requestKeywordOverride !== null) {
                return originalSend.apply(xhr, sendArgs);
            }

            const entry = { keyword };
            if (!activeRequests.size) {
                activeKeyword = keyword;
            } else if (activeKeyword !== keyword) {
                activeKeyword = null;
            }
            activeRequests.set(xhr, entry);
            xhr.addEventListener('loadend', () => finishRequest(xhr, entry), { once: true });
            return originalSend.apply(xhr, sendArgs);
        }

        function sendPendingRequest(entry) {
            if (!entry || entry.sent) return;
            entry.sent = true;
            clearTimeout(entry.maxWaitTimer);
            pendingRequests.delete(entry);
            entry.xhr.__kubeExplorerPendingPriorityListRequest = null;
            if (entry.xhr.readyState !== win.XMLHttpRequest.OPENED) return;
            sendRequest(entry.xhr, entry.originalSend, entry.sendArgs);
        }

        function finishRequest(xhr, entry) {
            if (activeRequests.get(xhr) !== entry) return;
            activeRequests.delete(xhr);
            if (activeRequests.size || reloadInProgress) return;

            loadedKeyword = activeKeyword;
            activeKeyword = null;
            if (reloadRequested && getKeyword() !== loadedKeyword) {
                scheduleReload(0);
                return;
            }

            reloadRequested = false;
            const completedKeyword = loadedKeyword;
            restoreCompleteRelatedLists(options.getClusterStore(), completedKeyword);
            refreshDelayedColumns().finally(() => {
                if (!reloadRequested && getKeyword() === completedKeyword) {
                    setLoading(false);
                }
            });
        }

        function flushPendingRequests() {
            clearTimeout(inputFlushTimer);
            inputFlushTimer = null;
            Array.from(pendingRequests).forEach(sendPendingRequest);
        }

        function schedulePendingFlush(delay) {
            if (!pendingRequests.size) return;
            clearTimeout(inputFlushTimer);
            inputFlushTimer = setTimeout(flushPendingRequests, delay);
        }

        async function reloadLists() {
            reloadTimer = null;
            if (!isDeploymentListPage()) {
                reloadRequested = false;
                loadedKeyword = null;
                setLoading(false);
                return;
            }

            const keyword = getKeyword();
            if (keyword === loadedKeyword) {
                reloadRequested = false;
                setLoading(false);
                return;
            }
            if (pendingRequests.size || activeRequests.size || reloadInProgress || relatedRestorePromise) {
                reloadRequested = true;
                return;
            }

            const store = options.getClusterStore();
            if (!store || typeof store.dispatch !== 'function') {
                scheduleReload(100);
                return;
            }

            reloadInProgress = true;
            reloadRequested = false;
            try {
                await Promise.all([
                    store.dispatch('cluster/findAll', { type: 'apps.replicaset', opt: { force: true } }),
                    store.dispatch('cluster/findAll', { type: 'pod', opt: { force: true } })
                ]);
                if (getKeyword() !== keyword) return;
                await store.dispatch('cluster/findAll', { type: 'apps.deployment', opt: { force: true } });
                if (!activeRequests.size) {
                    loadedKeyword = keyword;
                    activeKeyword = null;
                    restoreCompleteRelatedLists(store, keyword);
                    await refreshDelayedColumns();
                    if (getKeyword() === keyword) setLoading(false);
                }
            } catch (error) {
                setLoading(false);
                console.error('Failed reloading filtered workload resources', error);
            } finally {
                reloadInProgress = false;
                if (reloadRequested && getKeyword() !== loadedKeyword) scheduleReload(0);
            }
        }

        function scheduleReload(delay) {
            reloadRequested = true;
            clearTimeout(reloadTimer);
            reloadTimer = setTimeout(reloadLists, delay);
        }

        function restoreCompleteRelatedLists(store, filteredKeyword) {
            if (!filteredKeyword || relatedRestorePromise || !store || typeof store.dispatch !== 'function') {
                return relatedRestorePromise;
            }

            const promise = (async () => {
                requestKeywordOverride = '';
                try {
                    await Promise.all([
                        store.dispatch('cluster/findAll', { type: 'apps.replicaset', opt: { force: true } }),
                        store.dispatch('cluster/findAll', { type: 'pod', opt: { force: true } })
                    ]);
                } catch (error) {
                    console.error('Failed restoring complete workload relations', error);
                } finally {
                    requestKeywordOverride = null;
                }
            })();
            relatedRestorePromise = promise.finally(() => {
                relatedRestorePromise = null;
                if (reloadRequested && isDeploymentListPage()) scheduleReload(0);
            });
            return relatedRestorePromise;
        }

        function hasDeploymentRows(tbody) {
            return !!(tbody && tbody.querySelector('a[href*="/apps.deployment/"]'));
        }

        function removeStaleRows() {
            if (doc.body) doc.body.classList.remove('priority-list-filter-stale-visible');
            if (staleObserver) staleObserver.disconnect();
            staleTbodies.forEach((tbody) => {
                if (tbody.parentNode) tbody.parentNode.removeChild(tbody);
            });
            staleObserver = null;
            staleTbodies = [];
            staleTable = null;
        }

        function syncStaleRows() {
            if (!staleTbodies.length || !staleTable || !doc.body ||
                !doc.body.classList.contains('priority-list-filter-loading')) return;

            const liveTbodies = Array.from(
                staleTable.querySelectorAll('tbody:not(.priority-list-filter-stale)')
            );
            const showStaleRows = !liveTbodies.some(hasDeploymentRows);
            staleTbodies.forEach((tbody) => {
                tbody.style.display = showStaleRows ? 'table-row-group' : 'none';
            });
            doc.body.classList.toggle('priority-list-filter-stale-visible', showStaleRows);
        }

        function preserveVisibleRows() {
            const table = doc.querySelector('main table');
            const liveTbodies = table ? Array.from(
                table.querySelectorAll('tbody:not(.priority-list-filter-stale)')
            ) : [];
            if (!liveTbodies.some(hasDeploymentRows)) return;

            removeStaleRows();
            staleTable = table;
            staleTbodies = liveTbodies.map((tbody) => {
                const clone = tbody.cloneNode(true);
                clone.classList.add('priority-list-filter-stale');
                clone.setAttribute('aria-hidden', 'true');
                clone.style.display = 'none';
                clone.inert = true;
                clone.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
                table.appendChild(clone);
                return clone;
            });

            if (typeof win.MutationObserver === 'function') {
                staleObserver = new win.MutationObserver(syncStaleRows);
                staleObserver.observe(table, { childList: true, subtree: true });
            }
        }

        function setLoading(loading) {
            if (loading) preserveVisibleRows();
            if (doc.body) doc.body.classList.toggle('priority-list-filter-loading', loading);
            if (loading) syncStaleRows();
            else removeStaleRows();
            const input = findFilterInput();
            if (!input) return;
            let spinner = input.parentElement && input.parentElement.querySelector('.priority-list-filter-spinner');
            if (!spinner && input.parentElement) {
                spinner = doc.createElement('i');
                spinner.className = 'initial-load-spinner priority-list-filter-spinner';
                spinner.setAttribute('aria-hidden', 'true');
                input.insertAdjacentElement('afterend', spinner);
            }
            if (spinner) spinner.hidden = !loading;
        }

        function findSortableTable() {
            const table = doc.querySelector('main table');
            const root = options.findVueComponent(table, 'ResourceTable');
            if (!root) return null;

            const queue = [root];
            const seen = new Set();
            while (queue.length) {
                const component = queue.shift();
                if (!component || seen.has(component)) continue;
                seen.add(component);
                if (component.$options && component.$options.name === 'SortableTable') return component;
                queue.push(...(component.$children || []));
            }
            return null;
        }

        async function refreshDelayedColumns() {
            await new Promise((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
            const sortableTable = findSortableTable();
            if (!sortableTable || typeof sortableTable.updateLiveAndDelayed !== 'function') return;
            sortableTable.updateLiveAndDelayed();

            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) {
                const rows = Array.from(doc.querySelectorAll(
                    'main table tbody:not(.priority-list-filter-stale) tr'
                )).filter((row) => {
                    const rect = row.getBoundingClientRect();
                    return rect.top >= 0 && rect.top <= (win.innerHeight + 100) && row.querySelector('a[href*="/apps.deployment/"]');
                });
                if (!rows.length || rows.every((row) => !row.querySelector('.hs-popover__loader, .delayed-loader'))) return;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }

        function bindFilterInput() {
            const input = findFilterInput();
            if (!input) return;
            if (!boundInputs.has(input)) {
                input.addEventListener('input', () => {
                    setLoading(true);
                    schedulePendingFlush(INPUT_SETTLE);
                    scheduleReload(INPUT_SETTLE);
                });
                boundInputs.add(input);
            }
            schedulePendingFlush(getKeyword() ? INPUT_SETTLE : INPUT_GRACE);
        }

        function isPriorityRequest(xhr) {
            if (!xhr || xhr.__kubeExplorerRequestMethod !== 'GET' || !isDeploymentListPage()) return false;
            const requestUrl = options.parseDashboardUrl(xhr.__kubeExplorerRequestUrl);
            if (!requestUrl || requestUrl.origin !== win.location.origin || !REQUEST_PATHS.has(requestUrl.pathname)) return false;
            return !requestUrl.searchParams.get('continue') && requestUrl.searchParams.get('watch') !== 'true';
        }

        function installRequestGate() {
            const XHR = win.XMLHttpRequest;
            if (!XHR || XHR.prototype.__kubeExplorerPriorityListGate) return;

            const originalOpen = XHR.prototype.open;
            const originalSend = XHR.prototype.send;
            const originalAbort = XHR.prototype.abort;
            XHR.prototype.open = function(method, url) {
                this.__kubeExplorerRequestMethod = String(method || '').toUpperCase();
                this.__kubeExplorerRequestUrl = String(url || '');
                return originalOpen.apply(this, arguments);
            };
            XHR.prototype.send = function() {
                options.watchDeploymentDetailWrite(this);
                if (!isPriorityRequest(this)) return originalSend.apply(this, arguments);

                const keyword = getKeyword();
                if (keyword) return sendRequest(this, originalSend, Array.from(arguments));

                const entry = {
                    xhr: this,
                    originalSend,
                    sendArgs: Array.from(arguments),
                    sent: false,
                    maxWaitTimer: null
                };
                this.__kubeExplorerPendingPriorityListRequest = entry;
                pendingRequests.add(entry);
                entry.maxWaitTimer = setTimeout(() => sendPendingRequest(entry), REQUEST_MAX_WAIT);
                bindFilterInput();
                return undefined;
            };
            XHR.prototype.abort = function() {
                const entry = this.__kubeExplorerPendingPriorityListRequest;
                if (entry && !entry.sent) {
                    entry.sent = true;
                    clearTimeout(entry.maxWaitTimer);
                    pendingRequests.delete(entry);
                    this.__kubeExplorerPendingPriorityListRequest = null;
                }
                return originalAbort.apply(this, arguments);
            };
            XHR.prototype.__kubeExplorerPriorityListGate = true;
        }

        return {
            bindFilterInput,
            getKeyword,
            installRequestGate,
            isDeploymentListPage
        };
    }

    return {
        create,
        normalizeFilterKeyword
    };
});
