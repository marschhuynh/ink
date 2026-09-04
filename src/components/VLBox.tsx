import {createBoxComponent, type BoxRef, type Props} from './Box.js';

// eslint-disable-next-line @typescript-eslint/naming-convention -- public VLBox API
export type VLBoxProps = Props;
// eslint-disable-next-line @typescript-eslint/naming-convention -- public VLBox API
export type VLBoxRef = BoxRef;

// eslint-disable-next-line @typescript-eslint/naming-convention -- public VLBox API
const VLBox = createBoxComponent('VLBox', true);
export default VLBox;
