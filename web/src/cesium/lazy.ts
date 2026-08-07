/** Defer a Cesium-touching module constant until first use. Cesium.js loads
 *  AT IDLE after first paint (see loader.ts), so module scope must not touch
 *  the `Cesium` global — it doesn't exist yet when these modules evaluate.
 *  `const C = lazy(() => Cesium.Color...)` + `C()` at the call site keeps the
 *  one-time-init semantics without the eval-time dependency. */
export function lazy<T>(make: () => T): () => T {
  let value: T | undefined
  return () => (value ??= make())
}
