import { Pipe, PipeTransform } from '@angular/core';

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/**
 * USD formatter for the backend-stamped estimated cost (Epic 57). The only
 * place a cost is rounded:
 *   - `0.004    → "<$0.01"` (never `"$0.00"`)
 *   - `1.234    → "$1.23"`
 *   - `1234.5   → "$1,234.50"`
 *
 * `0` means *unknown*, so it renders as `""` — as do null / undefined /
 * non-finite / negative inputs. Always en-US, whatever the UI language.
 */
@Pipe({
  name: 'usdCost',
  standalone: true,
})
export class UsdCostPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
      return '';
    }
    return value < 0.01 ? '<$0.01' : USD.format(value);
  }
}
