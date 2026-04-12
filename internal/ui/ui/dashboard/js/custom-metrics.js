(function() {
    'use strict';

    const CONFIG = {
        resourceType: 'pod',
        columns: [
            { key: 'cpuUsage', label: 'CPU', width: '100px' },
            { key: 'memoryUsage', label: 'RAM', width: '100px' }
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
    const REFRESH_INTERVAL = 10000;
    const ENABLE_NODE_POD_ENHANCEMENTS = true;
    const MIN_PROCESS_GAP = 700;
    let processTimer = null;
    let isProcessing = false;
    let pendingProcess = false;
    let lastProcessStartedAt = 0;
    let suppressMutationsUntil = 0;
    let rawPodsCache = null;
    let rawNodesCache = null;
    let rawPodMetricsCache = null;
    let rawPodsFetchedAt = 0;
    let rawNodesFetchedAt = 0;
    let rawPodMetricsFetchedAt = 0;
    let rawPodsPromise = null;
    let rawNodesPromise = null;
    let rawPodMetricsPromise = null;

    function normalizeHeaderText(text) {
        return (text || '')
            .toString()
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '')
            .replace(/[():\-_/]/g, '');
    }

    function getTableHeaderTexts(table) {
        const headers = table ? table.querySelectorAll('th') : [];
        return Array.from(headers).map((th) => normalizeHeaderText(th.textContent));
    }

    function hasAnyHeader(headerTexts, aliases) {
        return aliases.some((alias) => {
            const target = normalizeHeaderText(alias);
            return headerTexts.some((header) => header === target || header.includes(target));
        });
    }

    function headerIndexByAliases(headerRow, aliases) {
        if (!headerRow) return -1;
        const headers = Array.from(headerRow.querySelectorAll('th'));
        return headers.findIndex((th) => {
            const text = normalizeHeaderText(th.textContent);
            return aliases.some((alias) => {
                const target = normalizeHeaderText(alias);
                return text === target || text.includes(target);
            });
        });
    }

    function getCurrentLocale() {
        const store = getRootStore();
        const getters = store && store.getters ? store.getters : {};
        const getterCandidates = ['i18n/locale', 'prefs/locale', 'locale/current', 'lang/current'];
        for (const key of getterCandidates) {
            const value = getters[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }

        const stateCandidates = [
            store && store.state && store.state.i18n ? store.state.i18n.locale : '',
            store && store.state && store.state.prefs ? store.state.prefs.locale : '',
            document.documentElement ? document.documentElement.lang : '',
            navigator.language || ''
        ];
        for (const value of stateCandidates) {
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
        return '';
    }

    function isEnglishLocale() {
        return /^en(?:[-_]|$)/i.test(getCurrentLocale());
    }

    function getNodePodTexts() {
        if (isEnglishLocale()) {
            return {
                deleteLabel: 'Delete',
                selectedTip: (count) => `Selected ${count}`,
                confirmDeleteOne: (ref) => `Confirm delete Pod ${ref.namespace}/${ref.name}?`,
                confirmDeleteBatch: (count) => `Confirm delete ${count} selected Pods?`,
                deleteFailed: (error) => `Delete failed: ${error}`,
                batchDeletePartial: (success, total, failed, details) => `Deleted ${success}/${total}, failed ${failed}.\n${details}`,
                executeShell: 'Execute Shell',
                viewLogs: 'View Logs',
                editConfig: 'Edit Config',
                editYAML: 'Edit YAML',
                clone: 'Clone',
                downloadYAML: 'Download YAML'
            };
        }

        return {
            deleteLabel: '删除',
            selectedTip: (count) => `已选择 ${count} 项`,
            confirmDeleteOne: (ref) => `确认删除 Pod ${ref.namespace}/${ref.name} 吗？`,
            confirmDeleteBatch: (count) => `确认删除已选择的 ${count} 个 Pod 吗？`,
            deleteFailed: (error) => `删除失败: ${error}`,
            batchDeletePartial: (success, total, failed, details) => `已删除 ${success}/${total}，失败 ${failed} 个。\n${details}`,
            executeShell: '执行终端',
            viewLogs: '查看日志',
            editConfig: '编辑配置',
            editYAML: '编辑 YAML',
            clone: '克隆',
            downloadYAML: '下载 YAML'
        };
    }

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

            .node-pod-actions-bar {
                display: flex;
                align-items: center;
                justify-content: flex-start;
                margin: 6px 0 10px;
                gap: 10px;
            }

            .node-pod-delete-btn {
                min-width: 86px;
            }

            .node-pod-delete-btn i {
                margin-right: 6px;
            }

            .node-pod-selected-tip {
                color: #667085;
                font-size: 13px;
            }

            .node-pod-select-cell,
            .node-pod-select-header {
                width: 36px;
                min-width: 36px;
                text-align: center;
                vertical-align: middle;
            }

            .node-pod-op-header,
            .node-pod-op-cell {
                width: 74px;
                min-width: 74px;
                text-align: right;
                vertical-align: middle;
            }

            .node-pod-op-cell .btn.btn-sm.role-multi-action.actions {
                margin-right: 2px;
                border: 0 !important;
                background: transparent !important;
                box-shadow: none !important;
                padding-left: 4px;
                padding-right: 4px;
            }

            .node-pod-op-cell .btn.btn-sm.role-multi-action.actions:hover,
            .node-pod-op-cell .btn.btn-sm.role-multi-action.actions:focus,
            .node-pod-op-cell .btn.btn-sm.role-multi-action.actions:active {
                border: 0 !important;
                background: transparent !important;
                box-shadow: none !important;
            }

            .node-pod-action-menu-root {
                position: relative;
                display: inline-block;
            }

            .node-pod-action-menu-root .menu {
                position: fixed;
                display: none;
                top: 0;
                left: 0;
                z-index: 41;
                min-width: 145px;
                color: var(--dropdown-text);
                background-color: var(--dropdown-bg);
                border: 1px solid var(--dropdown-border);
                border-radius: 5px;
                box-shadow: 0 5px 20px var(--shadow);
            }

            .node-pod-action-menu-root.open .menu {
                display: block;
            }

            .node-pod-action-menu-root .menu li {
                align-items: center;
                display: flex;
                padding: 8px 10px;
                margin: 0;
            }

            .node-pod-action-menu-root .menu li[disabled] {
                cursor: not-allowed !important;
                color: var(--disabled-text);
            }

            .node-pod-action-menu-root .menu li.divider {
                padding: 0;
                border-bottom: 1px solid var(--dropdown-divider);
            }

            .node-pod-action-menu-root .menu li:not(.divider):hover {
                background-color: var(--dropdown-hover-bg);
                color: var(--dropdown-hover-text);
                cursor: pointer;
            }

            .node-pod-action-menu-root .menu li .icon {
                display: unset;
                width: 14px;
                text-align: center;
                margin-right: 8px;
            }

            .node-pod-floating-menu {
                position: fixed;
                top: 0;
                left: 0;
                z-index: 9999;
                min-width: 145px;
                color: var(--dropdown-text);
                background-color: var(--dropdown-bg);
                border: 1px solid var(--dropdown-border);
                border-radius: 5px;
                box-shadow: 0 5px 20px var(--shadow);
                margin: 0;
                padding: 0;
                list-style: none;
            }

            .node-pod-floating-menu li {
                align-items: center;
                display: flex;
                padding: 8px 10px;
                margin: 0;
            }

            .node-pod-floating-menu li.divider {
                padding: 0;
                border-bottom: 1px solid var(--dropdown-divider);
            }

            .node-pod-floating-menu li:not(.divider):hover {
                background-color: var(--dropdown-hover-bg);
                color: var(--dropdown-hover-text);
                cursor: pointer;
            }

            .node-pod-floating-menu li .icon {
                display: unset;
                width: 14px;
                text-align: center;
                margin-right: 8px;
            }

            .node-pod-op-cell,
            .node-pod-op-cell .node-pod-action-menu-root {
                overflow: visible !important;
            }

        `;
        document.head.appendChild(style);
    }

    function isPodTable(table) {
        const headerTexts = getTableHeaderTexts(table);
        if (!headerTexts.length) return false;
        const hasName = hasAnyHeader(headerTexts, ['name', '名称']);
        const hasReady = hasAnyHeader(headerTexts, ['ready', '就绪']);
        const hasRestarts = hasAnyHeader(headerTexts, ['restarts', '重启', '重启次数']);
        const hasIP = hasAnyHeader(headerTexts, ['ip', 'podip', '内部ip']);
        const hasNode = hasAnyHeader(headerTexts, ['node', '节点']);
        // Restrict to pod-style list tables to avoid deployment list pages.
        if (hasName && hasReady && hasRestarts && hasIP && hasNode) return true;

        // Locale-independent fallback: pod list rows include links containing /pod/{ns}/{name}.
        const podLinks = table.querySelectorAll('tbody a[href*="/pod/"]');
        return podLinks.length > 0;
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

    function isNodeDetailPage() {
        return /\/node\//i.test(window.location.pathname || '');
    }

    function findNodeDetailPodTables() {
        if (!isNodeDetailPage()) return [];
        const tables = Array.from(document.querySelectorAll('table'));
        return tables.filter((table) => {
            const tbody = table.querySelector('tbody');
            if (!tbody) return false;
            return !!tbody.querySelector('a[href*="/pod/"]');
        });
    }

    function extractPodRefFromRow(row) {
        const link = row ? row.querySelector('a[href*="/pod/"]') : null;
        if (!link) return null;
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/pod\/([^\/?#]+)\/([^\/?#]+)/i);
        if (!match) return null;
        return {
            namespace: decodeURIComponent(match[1]),
            name: decodeURIComponent(match[2])
        };
    }

    async function deletePodResource(ref) {
        if (!ref || !ref.namespace || !ref.name) {
            throw new Error('invalid pod ref');
        }

        const url = `/v1/pods/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`;
        const resp = await fetch(url, {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!resp.ok && resp.status !== 404) {
            const body = await resp.text();
            throw new Error(`${ref.namespace}/${ref.name}: ${resp.status} ${body.slice(0, 160)}`);
        }
    }

    function getNodePodDataRows(table) {
        if (!table) return [];
        const tbody = table.querySelector('tbody');
        if (!tbody) return [];
        return Array.from(tbody.querySelectorAll('tr')).filter((row) => {
            if (row.querySelector('td[colspan]')) return false;
            return !!extractPodRefFromRow(row);
        });
    }

    function closeAllNodePodMenus() {
        document.querySelectorAll('.node-pod-action-menu-root.open').forEach((el) => el.classList.remove('open'));
        document.querySelectorAll('.node-pod-floating-menu').forEach((el) => el.remove());
        document.querySelectorAll('.node-pod-op-cell .actions[aria-expanded="true"]').forEach((el) => el.setAttribute('aria-expanded', 'false'));
    }

    function getRootStore() {
        const app = window.$globalApp || window.$nuxt || null;
        return app && app.$store ? app.$store : null;
    }

    function findPodResourceInStore(ref) {
        const store = getRootStore();
        if (!store || !ref) return null;
        const getters = store.getters || {};

        const matchesRef = (item) => {
            const md = item && item.metadata ? item.metadata : {};
            return md.namespace === ref.namespace && md.name === ref.name;
        };

        // 1) Try every `<store>/all` getter with common pod type ids.
        const allGetterNames = Object.keys(getters).filter((k) => /\/all$/.test(k));
        const typeCandidates = ['pod', 'pods'];
        for (const getterName of allGetterNames) {
            const getter = getters[getterName];
            if (typeof getter !== 'function') continue;
            for (const typeName of typeCandidates) {
                let list = [];
                try {
                    list = getter(typeName) || [];
                } catch (e) {
                    list = [];
                }
                const match = Array.isArray(list) ? list.find(matchesRef) : null;
                if (match) return match;
            }
        }

        // 2) Try every `<store>/byId` getter with common pod ids.
        const byIdGetterNames = Object.keys(getters).filter((k) => /\/byId$/.test(k));
        const idCandidates = [
            `${ref.namespace}/${ref.name}`,
            `${ref.namespace}:${ref.name}`,
            ref.name
        ];
        for (const getterName of byIdGetterNames) {
            const getter = getters[getterName];
            if (typeof getter !== 'function') continue;
            for (const typeName of typeCandidates) {
                for (const id of idCandidates) {
                    let item = null;
                    try {
                        item = getter(typeName, id);
                    } catch (e) {
                        item = null;
                    }
                    if (item && matchesRef(item)) return item;
                }
            }
        }
        return null;
    }

    async function hydratePodResourceInStore(ref) {
        const store = getRootStore();
        if (!store || !ref) return null;
        const getters = store.getters || {};
        const storeNames = Object.keys(getters)
            .filter((k) => /\/schemaFor$/.test(k))
            .map((k) => k.split('/')[0]);
        const uniqueStoreNames = Array.from(new Set(storeNames));
        const idCandidates = [
            `${ref.namespace}/${ref.name}`,
            `${ref.namespace}:${ref.name}`,
            ref.name
        ];
        const typeCandidates = ['pod', 'pods'];

        for (const storeName of uniqueStoreNames) {
            for (const typeName of typeCandidates) {
                for (const id of idCandidates) {
                    try {
                        await store.dispatch(`${storeName}/find`, { type: typeName, id });
                    } catch (e) {
                        // Continue trying other store/type/id combinations.
                    }
                    const found = findPodResourceInStore(ref);
                    if (found) return found;
                }
            }
        }
        return null;
    }

    async function openNativeDeleteConfirmForRefs(refs) {
        const store = getRootStore();
        if (!store || !Array.isArray(refs) || !refs.length) return false;
        let resources = refs.map(findPodResourceInStore).filter(Boolean);
        if (resources.length !== refs.length) {
            for (const ref of refs) {
                if (resources.find((r) => {
                    const md = r && r.metadata ? r.metadata : {};
                    return md.namespace === ref.namespace && md.name === ref.name;
                })) {
                    continue;
                }
                const hydrated = await hydratePodResourceInStore(ref);
                if (hydrated) resources.push(hydrated);
            }
        }
        if (!resources.length) return false;
        // Reset before opening to avoid toggle-state mismatch.
        store.commit('action-menu/togglePromptRemove', null);
        store.commit('action-menu/togglePromptRemove', resources);
        return true;
    }

    function ensureNodePodGlobalMenuHandler() {
        if (document.body.dataset.nodePodMenuBound === '1') return;
        document.body.dataset.nodePodMenuBound = '1';
        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            if (!target.closest('.node-pod-action-menu-root') && !target.closest('.node-pod-op-cell .actions') && !target.closest('.node-pod-floating-menu')) {
                closeAllNodePodMenus();
            }
        });
    }

    function updateNodePodDeleteButtonState(table) {
        const container = table ? table.parentElement : null;
        if (!container) return;
        const texts = getNodePodTexts();
        const deleteBtn = container.querySelector('.node-pod-delete-btn');
        if (!deleteBtn) return;
        const selectedTip = container.querySelector('.node-pod-selected-tip');

        const selectedRows = table.querySelectorAll('tbody .node-pod-row-checkbox:checked').length;
        deleteBtn.disabled = selectedRows === 0;
        deleteBtn.classList.toggle('role-primary', selectedRows > 0);
        deleteBtn.classList.toggle('bg-primary', selectedRows > 0);
        deleteBtn.classList.toggle('role-secondary', selectedRows === 0);
        if (selectedRows > 0) {
            deleteBtn.style.setProperty('background-color', '#5f9fd6', 'important');
            deleteBtn.style.setProperty('border-color', '#5f9fd6', 'important');
            deleteBtn.style.setProperty('color', '#ffffff', 'important');
        } else {
            deleteBtn.style.removeProperty('background-color');
            deleteBtn.style.removeProperty('border-color');
            deleteBtn.style.removeProperty('color');
        }
        if (selectedTip) {
            selectedTip.textContent = selectedRows > 0 ? texts.selectedTip(selectedRows) : '';
        }

        const allRows = getNodePodDataRows(table);
        const checkedCount = selectedRows;
        const selectAll = table.querySelector('thead .node-pod-select-all');
        if (selectAll) {
            selectAll.checked = allRows.length > 0 && checkedCount === allRows.length;
            selectAll.indeterminate = checkedCount > 0 && checkedCount < allRows.length;
        }
    }
    function ensureNodePodActionCell(row, table) {
        let cell = row.querySelector('td.node-pod-op-cell');
        if (!cell) {
            cell = document.createElement('td');
            cell.className = 'text-right node-pod-op-cell';
            row.appendChild(cell);
        }

        if (cell.dataset.nodePodBound === '1') return;
        cell.dataset.nodePodBound = '1';

        const ref = extractPodRefFromRow(row);
        if (!ref) return;

        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'btn btn-sm role-multi-action actions';
        trigger.setAttribute('aria-haspopup', 'true');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.innerHTML = '<i class="icon icon-actions"></i>';
        trigger.style.setProperty('border', '0', 'important');
        trigger.style.setProperty('background', 'transparent', 'important');
        trigger.style.setProperty('box-shadow', 'none', 'important');

        const menuRoot = document.createElement('div');
        menuRoot.className = 'node-pod-action-menu-root';

        const positionMenuNearTrigger = (menu) => {
            const rect = trigger.getBoundingClientRect();
            const menuWidth = Math.max(145, menu.offsetWidth || 145);
            const menuHeight = Math.max(220, menu.offsetHeight || 220);
            const gap = 4;
            let left = rect.right - menuWidth;
            let top = rect.bottom + gap;

            if (left < 8) left = 8;
            if (left + menuWidth > window.innerWidth - 8) left = window.innerWidth - menuWidth - 8;
            if (top + menuHeight > window.innerHeight - 8) top = rect.top - menuHeight - gap;
            if (top < 8) top = 8;

            menu.style.left = `${Math.round(left)}px`;
            menu.style.top = `${Math.round(top)}px`;
        };

        const podLink = row.querySelector('a[href*="/pod/"]');
        const podHref = podLink ? (podLink.getAttribute('href') || '') : '';

        const buildFloatingMenu = () => {
            const menu = document.createElement('ul');
            menu.className = 'list-unstyled menu node-pod-floating-menu';
            return menu;
        };

        const makeAction = (menu, label, icon, onClick, disabled) => {
            const li = document.createElement('li');
            if (disabled) li.setAttribute('disabled', 'disabled');
            const iconNode = document.createElement('i');
            iconNode.className = icon;
            const textNode = document.createElement('span');
            textNode.textContent = label;
            li.appendChild(iconNode);
            li.appendChild(textNode);
            li.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (disabled) return;
                closeAllNodePodMenus();
                await onClick();
            });
            return li;
        };

        const makeDivider = () => {
            const li = document.createElement('li');
            li.className = 'divider';
            return li;
        };

        const navigatePodDetail = async () => {
            if (!podHref) return;
            window.location.href = podHref;
        };

        const editConfig = async () => {
            if (!podHref) return;
            window.location.href = `${podHref}?mode=edit`;
        };

        const editYAML = async () => {
            if (!podHref) return;
            window.location.href = `${podHref}?as=yaml`;
        };

        const cloneResource = async () => {
            if (!podHref) return;
            window.location.href = `${podHref}?mode=clone`;
        };

        const downloadYAML = async () => {
            const url = `/v1/pods/${encodeURIComponent(ref.namespace)}/${encodeURIComponent(ref.name)}`;
            const resp = await fetch(url, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
            if (!resp.ok) throw new Error(`download failed: ${resp.status}`);
            const data = await resp.json();
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/yaml;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${ref.name}.yaml`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                URL.revokeObjectURL(a.href);
                a.remove();
            }, 0);
        };

        const deleteCurrent = async () => {
            const texts = getNodePodTexts();
            if (await openNativeDeleteConfirmForRefs([ref])) return;
            const confirmed = window.confirm(texts.confirmDeleteOne(ref));
            if (!confirmed) return;
            try {
                await deletePodResource(ref);
                rawPodsCache = null;
                rawPodsFetchedAt = 0;
                scheduleProcess(120);
            } catch (error) {
                console.error('Delete pod failed:', error);
                window.alert(texts.deleteFailed(error.message || error));
            }
        };

        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const alreadyOpen = trigger.getAttribute('aria-expanded') === 'true';
            closeAllNodePodMenus();
            if (alreadyOpen) return;

            const texts = getNodePodTexts();
            const menu = buildFloatingMenu();
            menu.appendChild(makeAction(menu, texts.executeShell, 'icon icon-fw icon-chevron-right', navigatePodDetail, false));
            menu.appendChild(makeAction(menu, texts.viewLogs, 'icon icon-fw icon-chevron-right', navigatePodDetail, false));
            menu.appendChild(makeDivider());
            menu.appendChild(makeAction(menu, texts.editConfig, 'icon icon-edit', editConfig, false));
            menu.appendChild(makeAction(menu, texts.editYAML, 'icon icon-file', editYAML, false));
            menu.appendChild(makeAction(menu, texts.clone, 'icon icon-copy', cloneResource, false));
            menu.appendChild(makeDivider());
            menu.appendChild(makeAction(menu, texts.downloadYAML, 'icon icon-download', downloadYAML, false));
            menu.appendChild(makeAction(menu, texts.deleteLabel, 'icon icon-trash', deleteCurrent, false));

            document.body.appendChild(menu);
            positionMenuNearTrigger(menu);
            trigger.setAttribute('aria-expanded', 'true');
        });

        cell.appendChild(trigger);
        cell.appendChild(menuRoot);
    }

    function ensureNodePodSelectionCell(row, table) {
        let cell = row.querySelector('td.node-pod-select-cell');
        if (!cell) {
            cell = document.createElement('td');
            cell.className = 'text-center node-pod-select-cell';
            row.insertBefore(cell, row.firstElementChild || null);
        }

        let checkbox = cell.querySelector('input.node-pod-row-checkbox');
        if (!checkbox) {
            checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'node-pod-row-checkbox';
            checkbox.addEventListener('change', () => updateNodePodDeleteButtonState(table));
            cell.appendChild(checkbox);
        }
    }

    function ensureNodePodHeaderColumns(table) {
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return;

        let selectHeader = headerRow.querySelector('th.node-pod-select-header');
        if (!selectHeader) {
            selectHeader = document.createElement('th');
            selectHeader.className = 'node-pod-select-header';
            const selectAll = document.createElement('input');
            selectAll.type = 'checkbox';
            selectAll.className = 'node-pod-select-all';
            selectAll.addEventListener('change', () => {
                const rows = getNodePodDataRows(table);
                rows.forEach((row) => {
                    const cb = row.querySelector('.node-pod-row-checkbox');
                    if (cb) cb.checked = selectAll.checked;
                });
                updateNodePodDeleteButtonState(table);
            });
            selectHeader.appendChild(selectAll);
            headerRow.insertBefore(selectHeader, headerRow.firstElementChild || null);
        }

        let opHeader = headerRow.querySelector('th.node-pod-op-header');
        if (!opHeader) {
            opHeader = document.createElement('th');
            opHeader.className = 'node-pod-op-header';
            opHeader.textContent = '';
            headerRow.appendChild(opHeader);
        }
    }

    function ensureNodePodBulkActions(table) {
        const container = table ? table.parentElement : null;
        if (!container) return;
        const texts = getNodePodTexts();

        let bar = container.querySelector('.node-pod-actions-bar');
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'node-pod-actions-bar';
            container.insertBefore(bar, table);
        }

        let deleteBtn = bar.querySelector('.node-pod-delete-btn');
        if (!deleteBtn) {
            deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'btn role-secondary node-pod-delete-btn';
            deleteBtn.innerHTML = `<i class="icon icon-trash"></i><span>${texts.deleteLabel}</span>`;
            deleteBtn.disabled = true;
            deleteBtn.addEventListener('click', async () => {
                const rows = getNodePodDataRows(table);
                const selectedRefs = rows.map((row) => {
                    const cb = row.querySelector('.node-pod-row-checkbox');
                    if (!cb || !cb.checked) return null;
                    return extractPodRefFromRow(row);
                }).filter(Boolean);

                if (!selectedRefs.length) return;
                if (await openNativeDeleteConfirmForRefs(selectedRefs)) return;
                const confirmed = window.confirm(texts.confirmDeleteBatch(selectedRefs.length));
                if (!confirmed) return;

                let success = 0;
                const errors = [];
                for (const ref of selectedRefs) {
                    try {
                        await deletePodResource(ref);
                        success += 1;
                    } catch (error) {
                        errors.push(`${ref.namespace}/${ref.name}: ${error.message || error}`);
                    }
                }

                rawPodsCache = null;
                rawPodsFetchedAt = 0;
                scheduleProcess(150);

                if (errors.length) {
                    console.error('Batch delete pod partial failures:', errors);
                    window.alert(texts.batchDeletePartial(success, selectedRefs.length, errors.length, errors.slice(0, 3).join('\n')));
                }
            });
            bar.appendChild(deleteBtn);
        }
        const deleteLabelNode = deleteBtn.querySelector('span');
        if (deleteLabelNode) deleteLabelNode.textContent = texts.deleteLabel;

        let selectedTip = bar.querySelector('.node-pod-selected-tip');
        if (!selectedTip) {
            selectedTip = document.createElement('span');
            selectedTip.className = 'node-pod-selected-tip';
            bar.appendChild(selectedTip);
        }
    }

    function enhanceNodeDetailPodTable(table) {
        if (!ENABLE_NODE_POD_ENHANCEMENTS) return;
        if (!isNodeDetailPage() || !table) return;
        ensureNodePodGlobalMenuHandler();
        ensureNodePodHeaderColumns(table);
        ensureNodePodBulkActions(table);

        const rows = getNodePodDataRows(table);
        rows.forEach((row) => {
            ensureNodePodSelectionCell(row, table);
            ensureNodePodActionCell(row, table);
        });

        updateNodePodDeleteButtonState(table);
    }

    function processNodeDetailPodEnhancements() {
        if (!ENABLE_NODE_POD_ENHANCEMENTS) return;
        const tables = findNodeDetailPodTables();
        if (!tables.length) return;
        tables.forEach((table) => {
            enhanceNodeDetailPodTable(table);
        });
    }

    function isNodeTable(table) {
        const headerTexts = getTableHeaderTexts(table);
        if (!headerTexts.length) return false;
        const hasName = hasAnyHeader(headerTexts, ['name', '名称']);
        const hasOS = hasAnyHeader(headerTexts, ['os', '操作系统']);
        const hasCPU = hasAnyHeader(headerTexts, ['cpu']);
        const hasRAM = hasAnyHeader(headerTexts, ['ram', 'memory', '内存']);
        const hasPods = hasAnyHeader(headerTexts, ['pods', 'pod', 'pods数', 'pod数量']);
        if (hasName && hasOS && hasCPU && hasRAM && hasPods) return true;
        const nodeLinks = table.querySelectorAll('tbody a[href*="/node/"]');
        return nodeLinks.length > 0;
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
        const findHeaderIndex = (aliases) => {
            const list = Array.isArray(aliases) ? aliases : [aliases];
            return headerIndexByAliases(headerRow, list);
        };
        const findMemoryHeaderIndex = () => {
            const all = headers();
            return all.findIndex((th) => {
                const text = normalizeHeaderText(th.textContent);
                return text.startsWith('ram') || text.startsWith('memory') || text.includes('内存');
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

        const restartIndex = findHeaderIndex(['Restarts', '重启', '重启次数']);
        let cpuIndex = findHeaderIndex(['CPU']);
        let memoryIndex = findMemoryHeaderIndex();
        if (cpuIndex < 0 && restartIndex >= 0) {
            insertHeaderAt(restartIndex + 1, 'CPU', 'cpuUsage');
            cpuIndex = findHeaderIndex(['CPU']);
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
                cpuIndex = findHeaderIndex(['CPU']);
                memoryIndex = findMemoryHeaderIndex();
            }
            if (memoryIndex !== restartIndex + 2) {
                moveColumn(memoryIndex, restartIndex + 2);
                cpuIndex = findHeaderIndex(['CPU']);
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
        const findIdx = (pred) => headers.findIndex((th) => pred(normalizeHeaderText(th.textContent)));
        const cpuIdx = findIdx((t) => t.startsWith('cpu'));
        const ramIdx = findIdx((t) => t.startsWith('ram') || t.startsWith('memory') || t.includes('内存'));
        const ageIdx = findIdx((t) => t.startsWith('age') || t === '年龄');
        const layoutSig = `${cpuIdx}|${ramIdx}|${ageIdx}|${colWidthByKey('cpuUsage')}|${colWidthByKey('memoryUsage')}|${colWidthByKey('age')}`;
        const lastSig = table.dataset.podLayoutSig || '';

        const setHeaderWidth = (idx, w) => {
            if (idx < 0 || !w) return;
            headers[idx].style.width = w;
            headers[idx].style.minWidth = w;
        };
        if (lastSig !== layoutSig) {
            setHeaderWidth(cpuIdx, colWidthByKey('cpuUsage'));
            setHeaderWidth(ramIdx, colWidthByKey('memoryUsage'));
            setHeaderWidth(ageIdx, colWidthByKey('age'));
            table.dataset.podLayoutSig = layoutSig;
        }

        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.forEach((row) => {
            if (row.dataset.podLayoutSigApplied === layoutSig) return;
            const cells = row.querySelectorAll('td');
            const setCellWidth = (idx, w) => {
                if (idx < 0 || !w || !cells[idx]) return;
                cells[idx].style.width = w;
                cells[idx].style.minWidth = w;
            };
            setCellWidth(cpuIdx, colWidthByKey('cpuUsage'));
            setCellWidth(ramIdx, colWidthByKey('memoryUsage'));
            setCellWidth(ageIdx, colWidthByKey('age'));
            row.dataset.podLayoutSigApplied = layoutSig;
        });
    }

    function getHeaderIndexes(table) {
        const result = {};
        if (!table) return result;
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return result;
        const headers = Array.from(headerRow.querySelectorAll('th'));
        headers.forEach((th, index) => {
            const text = normalizeHeaderText(th.textContent);
            if (!text) return;
            if ((text.startsWith('restarts') || text.includes('重启')) && typeof result.restarts !== 'number') result.restarts = index;
            if (text.startsWith('cpu') && typeof result.cpu !== 'number') result.cpu = index;
            if ((text.startsWith('memory') || text.startsWith('ram') || text.includes('内存')) && typeof result.memory !== 'number') result.memory = index;
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
            '/v1/metrics.k8s.io.pods?exclude=metadata.managedFields',
        ], 'pod metrics');
    }

    async function getPodsData() {
        const now = Date.now();
        if (rawPodsCache && now - rawPodsFetchedAt < CACHE_DURATION) {
            return rawPodsCache;
        }
        if (rawPodsPromise) {
            return rawPodsPromise;
        }
        rawPodsPromise = fetchPodsJSON()
            .then((data) => {
                rawPodsCache = data;
                rawPodsFetchedAt = Date.now();
                return data;
            })
            .finally(() => {
                rawPodsPromise = null;
            });
        return rawPodsPromise;
    }

    async function getNodesData() {
        const now = Date.now();
        if (rawNodesCache && now - rawNodesFetchedAt < CACHE_DURATION) {
            return rawNodesCache;
        }
        if (rawNodesPromise) {
            return rawNodesPromise;
        }
        rawNodesPromise = fetchNodesJSON()
            .then((data) => {
                rawNodesCache = data;
                rawNodesFetchedAt = Date.now();
                return data;
            })
            .finally(() => {
                rawNodesPromise = null;
            });
        return rawNodesPromise;
    }

    async function getPodMetricsData() {
        const now = Date.now();
        if (rawPodMetricsCache && now - rawPodMetricsFetchedAt < CACHE_DURATION) {
            return rawPodMetricsCache;
        }
        if (rawPodMetricsPromise) {
            return rawPodMetricsPromise;
        }
        rawPodMetricsPromise = fetchPodMetricsJSON()
            .then((data) => {
                rawPodMetricsCache = data;
                rawPodMetricsFetchedAt = Date.now();
                return data;
            })
            .finally(() => {
                rawPodMetricsPromise = null;
            });
        return rawPodMetricsPromise;
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
            const [nodesData, podsData] = await Promise.all([getNodesData(), getPodsData()]);
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
            const podsData = await getPodsData();
            const pods = podsData.data || [];
            const podMetricsData = await getPodMetricsData();
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

    function metricRenderSignature(usage, request, limit, unit) {
        return [
            unit,
            Math.round(usage || 0),
            Math.round(request || 0),
            Math.round(limit || 0)
        ].join('|');
    }

    function renderMetricCell(cell, usage, request, limit, unit) {
        const sig = metricRenderSignature(usage, request, limit, unit);
        if (cell.dataset.metricSig === sig) return;
        cell.dataset.metricSig = sig;

        const hasData = usage > 0 || request > 0 || limit > 0;
        if (!hasData) {
            if (cell.dataset.metricMode !== 'empty' || cell.textContent !== '-') {
                cell.textContent = '-';
                cell.dataset.metricMode = 'empty';
            }
            return;
        }

        let container = cell.querySelector('.metrics-progress-container');
        if (!container || cell.dataset.metricMode !== 'bar') {
            cell.innerHTML = '';
            cell.style.background = 'transparent';
            container = createProgressBar(usage, request, limit, unit);
            cell.appendChild(container);
            cell.dataset.metricMode = 'bar';
            return;
        }

        const fill = container.querySelector('.metrics-progress-fill');
        const value = container.querySelector('.metrics-value');
        const requestLimit = container.querySelector('.metrics-request-limit');
        const percentage = calculateUsagePercentage(usage, request, limit);
        const limitPercentage = limit > 0 ? (usage / limit) * 100 : 0;
        if (fill) {
            fill.style.width = `${Math.min(percentage, 100)}%`;
            fill.classList.toggle('limit-warning', limit > 0 && limitPercentage >= 90);
        }
        if (value) value.textContent = `${Math.round(usage)}${unit}`;
        if (requestLimit) {
            const parts = [];
            if (request > 0) parts.push(`Req ${Math.round(request)}${unit}`);
            if (limit > 0) parts.push(`Lim ${Math.round(limit)}${unit}`);
            requestLimit.textContent = parts.length > 0 ? parts.join(' / ') : '-';
        }
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
            const text = normalizeHeaderText(th.textContent);
            const key = text.startsWith('cpu')
                ? 'cpuUsage'
                : ((text.startsWith('memory') || text.startsWith('ram') || text.includes('内存')) ? 'memoryUsage' : '');
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

                if (col.key === 'cpuUsage') {
                    const cpuUsage = podMetrics ? podMetrics.cpuUsageValue : 0;
                    const cpuRequest = podResources ? podResources.cpuRequest : 0;
                    const cpuLimit = podResources ? podResources.cpuLimit : 0;
                    renderMetricCell(cell, cpuUsage, cpuRequest, cpuLimit, 'm');
                } else if (col.key === 'memoryUsage') {
                    const memoryUsage = podMetrics ? podMetrics.memoryUsageValue : 0;
                    const memoryRequest = podResources ? podResources.memoryRequest : 0;
                    const memoryLimit = podResources ? podResources.memoryLimit : 0;
                    renderMetricCell(cell, memoryUsage, memoryRequest, memoryLimit, 'Mi');
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
            const text = normalizeHeaderText(th.textContent);
            if (!text) return;
            if ((text === 'name' || text === '名称') && typeof result.name !== 'number') result.name = index;
            if ((text.startsWith('version') || text.includes('版本')) && typeof result.version !== 'number') result.version = index;
            if ((text.startsWith('externalinternalip') || text.includes('内部ip') || text.includes('externalinternalip')) && typeof result.ip !== 'number') result.ip = index;
            if (text.startsWith('cpu') && typeof result.cpu !== 'number') result.cpu = index;
            if ((text.startsWith('ram') || text.startsWith('memory') || text.includes('内存')) && typeof result.ram !== 'number') result.ram = index;
        });
        return result;
    }

    function applyNodeColumnLayout(table, headerIndexes) {
        if (!table || !headerIndexes) return;
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) return;
        const layoutSig = `${headerIndexes.version}|${headerIndexes.ip}|${headerIndexes.cpu}|${headerIndexes.ram}|170|340|200|200`;
        const lastSig = table.dataset.nodeLayoutSig || '';

        const headers = headerRow.querySelectorAll('th');
        const setHeaderWidth = (index, width) => {
            if (typeof index !== 'number' || index < 0 || !headers[index]) return;
            headers[index].style.width = width;
            headers[index].style.minWidth = width;
        };

        if (lastSig !== layoutSig) {
            // Rebalance Node list columns: shrink Version, slightly widen IP, keep CPU/RAM roomy.
            setHeaderWidth(headerIndexes.version, '170px');
            setHeaderWidth(headerIndexes.ip, '340px');
            setHeaderWidth(headerIndexes.cpu, '200px');
            setHeaderWidth(headerIndexes.ram, '200px');
            table.dataset.nodeLayoutSig = layoutSig;
        }

        const tbody = table.querySelector('tbody');
        if (!tbody) return;
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.forEach((row) => {
            if (row.dataset.nodeLayoutSigApplied === layoutSig) return;
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
            row.dataset.nodeLayoutSigApplied = layoutSig;
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
            const layoutSig = [
                cpuLeft,
                Math.max(180, Math.round(cpuRect.width)),
                Math.max(180, Math.round(ramRect.width)),
                gap
            ].join('|');
            if (container.dataset.layoutSig !== layoutSig) {
                container.dataset.layoutSig = layoutSig;
                container.style.left = `${cpuLeft}px`;
                container.style.marginLeft = '0px';
                if (cpuBlock) cpuBlock.style.minWidth = `${Math.max(180, Math.round(cpuRect.width))}px`;
                if (ramBlock) ramBlock.style.minWidth = `${Math.max(180, Math.round(ramRect.width))}px`;
                if (ramBlock) ramBlock.style.marginLeft = `${gap}px`;
            }
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

        const summarySig = [
            cpuReqPct.toFixed(3),
            cpuLimPct.toFixed(3),
            memReqPct.toFixed(3),
            memLimPct.toFixed(3),
            cpuTotalLabel,
            memTotalLabel
        ].join('|');
        if (container.dataset.summarySig === summarySig) {
            return;
        }
        container.dataset.summarySig = summarySig;

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
            enhanceNodeDetailPodTable(table);
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

    async function runProcessCycle() {
        if (isProcessing) {
            pendingProcess = true;
            return;
        }
        isProcessing = true;
        lastProcessStartedAt = Date.now();
        suppressMutationsUntil = lastProcessStartedAt + 800;
        try {
            processNodeDetailPodEnhancements();
            await processPodsPage();
            await processNodesPage();
        } finally {
            isProcessing = false;
            suppressMutationsUntil = Date.now() + 300;
            if (pendingProcess) {
                pendingProcess = false;
                scheduleProcess(120);
            }
        }
    }

    function scheduleProcess(delay = 50) {
        const now = Date.now();
        const gapWait = Math.max(0, MIN_PROCESS_GAP - (now - lastProcessStartedAt));
        const wait = Math.max(delay, gapWait);
        if (processTimer) {
            clearTimeout(processTimer);
        }
        processTimer = setTimeout(async () => {
            processTimer = null;
            await runProcessCycle();
        }, wait);
    }

    function observeChanges() {
        if (observer) {
            observer.disconnect();
        }

        observer = new MutationObserver((mutations) => {
            if (Date.now() < suppressMutationsUntil) return;
            if (isProcessing) return;
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
            if (document.hidden) return;
            scheduleProcess(120);
        }, REFRESH_INTERVAL);
    }

    init();
})();
