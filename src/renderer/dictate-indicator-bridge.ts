// The dictation pill's bridge: it only ever listens.

import { listen } from './bridge-common.js';
import type { DictateIndicatorBridge } from './bridges';
import type { DictateIndicatorState } from '../shared/types';

const api: DictateIndicatorBridge = {
  onState: (fn) => listen<Partial<DictateIndicatorState>>('dictate:state', (payload) => fn(payload ?? {})),
};

window.dictateIndicator = api;
