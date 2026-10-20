import type { Resource } from '@angular/core';

/**
 * Lee el valor de un resource sin lanzar: en Angular 21 `value()` de un resource en estado de
 * error lanza ResourceValueError. Devuelve undefined mientras carga o si falló.
 */
export function valueOf<T>(r: Resource<T>): T | undefined {
  return r.hasValue() ? r.value() : undefined;
}
