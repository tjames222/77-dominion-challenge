import { createShareComposerLoader } from './share-composer-loader.mjs';

const loader = createShareComposerLoader(() => import('./share-composer.js'));
export const initShareComposer = loader.initShareComposer;
export const closeShareComposer = loader.closeShareComposer;

initShareComposer();
