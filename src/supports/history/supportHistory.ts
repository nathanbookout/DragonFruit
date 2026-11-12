import { createTypedHistory } from '@/history/typedHistory';
import type { SupportHistoryPayloadMap } from './actionTypes';
import { SUPPORT_HISTORY_LABELS } from './supportHistoryLabels';

const supportHistory = createTypedHistory<SupportHistoryPayloadMap>(SUPPORT_HISTORY_LABELS);

/**
 * Push a support history entry with the payload its type requires. The compiler
 * rejects a payload that doesn't match the action type, so a push site can't
 * drift from the handler that inverts it.
 */
export const pushSupportHistory: typeof supportHistory.push = (...args) => {
    if (isSupportHistorySuppressed()) return;
    return supportHistory.push(...args);
};

let supportHistorySuppressionDepth = 0;

/** Whether a `withSupportHistorySuppressed` block is running. */
export function isSupportHistorySuppressed(): boolean {
    return supportHistorySuppressionDepth > 0;
}

/**
 * Run `apply` without recording support history entries, so a caller can record
 * the whole change as one snapshot entry instead (e.g. symmetry copies).
 */
export function withSupportHistorySuppressed<T>(apply: () => T): T {
    supportHistorySuppressionDepth += 1;
    try {
        return apply();
    } finally {
        supportHistorySuppressionDepth -= 1;
    }
}

/**
 * Register a handler that receives its action's payload already narrowed, so no
 * handler body has to cast `action.payload`.
 */
export const registerSupportHistoryHandler = supportHistory.register;
