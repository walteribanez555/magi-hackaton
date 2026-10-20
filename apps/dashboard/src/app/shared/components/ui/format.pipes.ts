import { Pipe, type PipeTransform } from '@angular/core';

import {
  formatAgo,
  formatDateTime,
  formatDay,
  formatNumber,
  formatPercent,
  formatScore,
  shortSha,
} from '@/shared/utils/format';

@Pipe({ name: 'num' })
export class NumPipe implements PipeTransform {
  transform(v: number | null | undefined, decimals = 0): string {
    return formatNumber(v, decimals);
  }
}

@Pipe({ name: 'pct' })
export class PctPipe implements PipeTransform {
  transform(v: number | null | undefined, decimals = 1): string {
    return formatPercent(v, decimals);
  }
}

@Pipe({ name: 'score' })
export class ScorePipe implements PipeTransform {
  transform(v: number | null | undefined): string {
    return formatScore(v);
  }
}

@Pipe({ name: 'day' })
export class DayPipe implements PipeTransform {
  transform(v: string | null | undefined): string {
    return formatDay(v);
  }
}

@Pipe({ name: 'datetime' })
export class DateTimePipe implements PipeTransform {
  transform(v: string | null | undefined): string {
    return formatDateTime(v);
  }
}

@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(v: string | null | undefined): string {
    return formatAgo(v);
  }
}

@Pipe({ name: 'sha' })
export class ShaPipe implements PipeTransform {
  transform(v: string | null | undefined): string {
    return shortSha(v);
  }
}

export const FORMAT_PIPES = [NumPipe, PctPipe, ScorePipe, DayPipe, DateTimePipe, AgoPipe, ShaPipe] as const;
