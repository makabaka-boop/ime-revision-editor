import { flush, report } from './framework.js';
import './model.test.js';
import './editor.test.js';
import './render.test.js';

await flush();
report();
