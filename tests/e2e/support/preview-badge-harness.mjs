// Test-only entry: absent from PRODUCTION_ENTRYPOINTS and normal dist.
import * as api from '../../../src/static/api.js';
import { createClient } from '@supabase/supabase-js';
import { peekPreviewUserValue, writePreviewUserValue } from '../../../src/static/preview-user-state.mjs';
window.__previewBadgeTest = Object.freeze({ api, createClient, peekPreviewUserValue, writePreviewUserValue });
