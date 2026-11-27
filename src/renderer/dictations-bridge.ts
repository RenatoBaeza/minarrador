// The dictation archive's bridge to the Rust core.

import { enableDrag, invoke, listen } from './bridge-common.js';
import type { DictationsBridge } from './bridges';

const api: DictationsBridge = {
  list: () => invoke('dictations_list'),
  update: (id, text) => invoke('dictations_update', { id: String(id ?? ''), text: String(text ?? '') }),
  remove: (id) => invoke('dictations_remove', { id: String(id ?? '') }),
  copy: (text) => void invoke('dictations_copy', { text: String(text ?? '') }),
  close: () => void invoke('dictations_close'),
  onChanged: (fn) => listen('dictations:changed', () => fn()),
};

window.dictations = api;
enableDrag('header');
