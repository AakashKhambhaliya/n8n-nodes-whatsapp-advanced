'use strict';

const assert = require('assert');

/**
 * Tiny sequential runner. Tests are queued rather than run on the spot so that
 * an async test is awaited before the next one starts — the routing suite
 * shares a module-level template cache and would interleave otherwise.
 */

const queue = [];
let suiteName = 'suite';

function suite(name) {
	suiteName = name;
	process.stdout.write(`\n${name}\n${'─'.repeat(name.length)}\n`);
}

function test(name, fn) {
	queue.push({ name, fn });
}

function done() {
	return (async () => {
		let passed = 0;
		const failures = [];

		for (const entry of queue) {
			try {
				await entry.fn();
				passed++;
				process.stdout.write(`  ✓ ${entry.name}\n`);
			} catch (error) {
				failures.push({ name: entry.name, error });
				process.stdout.write(`  ✗ ${entry.name}\n`);
			}
		}

		process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);

		for (const failure of failures) {
			process.stdout.write(`\n✗ ${failure.name}\n${failure.error.stack}\n`);
		}

		if (failures.length > 0) {
			process.stdout.write(`\n${suiteName}: ${failures.length} test(s) failed\n`);
			process.exitCode = 1;
		}
	})();
}

/** A minimal INode stand-in — the pure helpers only ever read `.name`. */
const fakeNode = {
	id: 'test',
	name: 'WhatsApp Advanced',
	type: 'whatsAppAdvanced',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

const ids = (fields) => fields.map((f) => f.id);

const labelFor = (fields, id) => (fields.find((f) => f.id === id) || {}).displayName;

module.exports = { assert, suite, test, done, fakeNode, ids, labelFor };
