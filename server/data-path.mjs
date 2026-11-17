import path from 'node:path';
import {fileURLToPath} from 'node:url';

const appRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const dataRoot=path.resolve(process.env.STUDY_DATA_ROOT||path.join(appRoot,'.data'));
