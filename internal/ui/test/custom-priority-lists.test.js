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
