import { createShareComposerLoader } from './share-composer-loader.mjs';
import '../assets/share-trigger.css';

const loader = createShareComposerLoader(() => import('./share-composer.js'));
export const initShareComposer = loader.initShareComposer;
export const closeShareComposer = loader.closeShareComposer;

initShareComposer();
