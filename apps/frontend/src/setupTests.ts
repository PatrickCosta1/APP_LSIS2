import '@testing-library/jest-dom/vitest';

// Vitest (jsdom) não traz ResizeObserver por defeito.
class ResizeObserverMock {
	observe() {}
	unobserve() {}
	disconnect() {}
}

if (!('ResizeObserver' in globalThis)) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	(globalThis as any).ResizeObserver = ResizeObserverMock;
}
