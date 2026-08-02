'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const priorityLists = require('../ui/dashboard/js/custom-priority-lists.js');

test('normalizeFilterKeyword accepts supported search values', () => {
    assert.equal(priorityLists.normalizeFilterKeyword('  v4-api:1.2  '), 'v4-api:1.2');
    assert.equal(priorityLists.normalizeFilterKeyword('namespace/image@sha256'), 'namespace/image@sha256');
});

test('normalizeFilterKeyword rejects expressions and oversized values', () => {
    assert.equal(priorityLists.normalizeFilterKeyword('v4,metadata.namespace=default'), '');
    assert.equal(priorityLists.normalizeFilterKeyword('x'.repeat(129)), '');
});

test('request gate adds the current keyword without delaying a filtered request', () => {
    class FakeXHR {
        constructor() {
            this.readyState = FakeXHR.OPENED;
            this.headers = {};
            this.sent = false;
            this.listeners = {};
        }

        open(method, url) {
            this.method = method;
            this.url = url;
        }

        setRequestHeader(name, value) {
            this.headers[name] = value;
        }

        addEventListener(name, callback) {
            this.listeners[name] = callback;
        }

        send() {
            this.sent = true;
        }

        abort() {}
    }
    FakeXHR.OPENED = 1;

    const input = {
        value: 'v4',
        parentElement: { querySelector: () => null },
        addEventListener: () => {},
        insertAdjacentElement: () => {}
    };
    const document = {
        body: { classList: { toggle: () => {} } },
        createElement: () => ({ setAttribute: () => {}, hidden: true }),
        querySelector: (selector) => selector.includes('input') ? input : null,
        querySelectorAll: () => []
    };
    const window = {
        XMLHttpRequest: FakeXHR,
        innerHeight: 900,
        location: {
            href: 'https://example.test/dashboard/c/local/explorer/apps.deployment',
            origin: 'https://example.test'
        },
        requestAnimationFrame: (callback) => callback()
    };
    let watched = 0;
    const controls = priorityLists.create({
        window,
        document,
        findVueComponent: () => null,
        getClusterStore: () => null,
        getListedResource: () => 'apps.deployment',
        parseDashboardUrl: (value) => new URL(value, window.location.href),
        watchDeploymentDetailWrite: () => { watched++; }
    });
    controls.installRequestGate();

    const xhr = new FakeXHR();
    xhr.open('GET', 'https://example.test/v1/apps.deployments');
    xhr.send();

    assert.equal(xhr.headers['X-Kube-Explorer-List-Filter-Keyword'], 'v4');
    assert.equal(xhr.sent, true);
    assert.equal(watched, 1);
});

test('filter loading preserves every visible deployment table body', () => {
    class FakeClassList {
        constructor() {
            this.values = new Set();
        }

        add(value) {
            this.values.add(value);
        }

        remove(value) {
            this.values.delete(value);
        }

        contains(value) {
            return this.values.has(value);
        }

        toggle(value, force) {
            if (force) this.values.add(value);
            else this.values.delete(value);
        }
    }

    const makeTbody = () => ({
        attributes: {},
        classList: new FakeClassList(),
        hasRows: true,
        inert: false,
        parentNode: null,
        style: {},
        cloneNode() {
            return makeTbody();
        },
        querySelector(selector) {
            return selector.includes('/apps.deployment/') && this.hasRows ? {} : null;
        },
        querySelectorAll() {
            return [];
        },
        setAttribute(name, value) {
            this.attributes[name] = value;
        }
    });

    const liveTbodies = [makeTbody(), makeTbody()];
    const table = {
        children: [...liveTbodies],
        appendChild(tbody) {
            tbody.parentNode = this;
            this.children.push(tbody);
        },
        querySelectorAll() {
            return this.children.filter((tbody) => !tbody.classList.contains('priority-list-filter-stale'));
        },
        removeChild(tbody) {
            this.children = this.children.filter((child) => child !== tbody);
            tbody.parentNode = null;
        }
    };
    liveTbodies.forEach((tbody) => { tbody.parentNode = table; });

    const inputListeners = {};
    const input = {
        value: '',
        parentElement: { querySelector: () => null },
        addEventListener(name, listener) {
            inputListeners[name] = listener;
        },
        insertAdjacentElement: () => {}
    };
    const body = { classList: new FakeClassList() };
    let mutationCallback = null;
    class FakeMutationObserver {
        constructor(callback) {
            mutationCallback = callback;
        }

        disconnect() {}
        observe() {}
    }

    const document = {
        body,
        createElement: () => ({ setAttribute: () => {}, hidden: true }),
        querySelector: (selector) => selector.includes('input') ? input : table,
        querySelectorAll: () => []
    };
    const window = {
        MutationObserver: FakeMutationObserver,
        XMLHttpRequest: class {},
        location: { href: 'https://example.test/dashboard/c/local/explorer/apps.deployment' },
        requestAnimationFrame: (callback) => callback()
    };
    const controls = priorityLists.create({
        window,
        document,
        findVueComponent: () => null,
        getClusterStore: () => ({ dispatch: async () => {} }),
        getListedResource: () => 'apps.deployment',
        parseDashboardUrl: (value) => new URL(value, window.location.href),
        watchDeploymentDetailWrite: () => {}
    });

    controls.bindFilterInput();
    inputListeners.input();

    const staleTbodies = table.children.filter((tbody) => {
        return tbody.classList.contains('priority-list-filter-stale');
    });
    assert.equal(staleTbodies.length, 2);
    assert.ok(staleTbodies.every((tbody) => tbody.style.display === 'none' && tbody.inert));

    liveTbodies.forEach((tbody) => { tbody.hasRows = false; });
    mutationCallback();

    assert.equal(body.classList.contains('priority-list-filter-stale-visible'), true);
    assert.ok(staleTbodies.every((tbody) => tbody.style.display === 'table-row-group'));
});
