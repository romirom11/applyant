// Overview RPC: the funnel and the PRD metrics over a window. validate → domain → proto.
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import type { ServiceImpl } from '@connectrpc/connect';
import { computeOverview, type OverviewWindow } from '../domain/overview.ts';
import {
  type ApplyantService,
  FunnelStepSchema,
  OverviewMetricSchema,
  OverviewRatioSchema,
  OverviewWindow as PbWindow,
} from '../gen/applyant/v1/applyant_pb.js';
import type { RpcContext } from './postings.ts';

type Impl = ServiceImpl<typeof ApplyantService>;

const WINDOW_FROM_PB: Record<PbWindow, OverviewWindow> = {
  [PbWindow.OVERVIEW_WINDOW_UNSPECIFIED]: '30d',
  [PbWindow.OVERVIEW_WINDOW_7_DAYS]: '7d',
  [PbWindow.OVERVIEW_WINDOW_30_DAYS]: '30d',
  [PbWindow.OVERVIEW_WINDOW_ALL]: 'all',
};
const WINDOW_TO_PB: Record<OverviewWindow, PbWindow> = {
  '7d': PbWindow.OVERVIEW_WINDOW_7_DAYS,
  '30d': PbWindow.OVERVIEW_WINDOW_30_DAYS,
  all: PbWindow.OVERVIEW_WINDOW_ALL,
};

export function overviewRpcs(c: RpcContext): Pick<Impl, 'getOverview'> {
  return {
    getOverview(req) {
      const o = computeOverview(c.db, WINDOW_FROM_PB[req.window] ?? '30d', c.now());
      return {
        window: WINDOW_TO_PB[o.window],
        since: o.since ? timestampFromDate(o.since) : undefined,
        funnel: o.funnel.map((s) =>
          create(FunnelStepSchema, { key: s.key, label: s.label, count: BigInt(s.count) }),
        ),
        metrics: o.metrics.map((m) =>
          create(OverviewMetricSchema, {
            key: m.key,
            label: m.label,
            definition: m.definition,
            target: m.target,
            display: m.display,
            met: m.met ?? undefined,
            value: m.value ?? undefined,
            ratio: m.ratio
              ? create(OverviewRatioSchema, {
                  numerator: BigInt(m.ratio.numerator),
                  denominator: BigInt(m.ratio.denominator),
                  ratio: m.ratio.ratio ?? undefined,
                })
              : undefined,
          }),
        ),
      };
    },
  };
}
