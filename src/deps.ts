/**
 * 外部依存(fetch / sleep)をまとめたもの。テストでは差し替える。
 *
 * 注意: Workers では `obj.fetch = fetch; obj.fetch(...)` のように
 * fetch を別オブジェクトのメソッドとして呼ぶと "Illegal invocation" になるため、
 * 必ずアロー関数でラップして保持する。
 */
export interface Deps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

export const defaultDeps: Deps = {
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
