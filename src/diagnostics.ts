import {getMeasureTextCacheSize} from './measure-text.js';
import {getWrapTextCacheSize} from './wrap-text.js';

export type InkCacheSizes = {
	measureText: number;
	wrapText: number;
};

export const getInkCacheSizes = (): InkCacheSizes => ({
	measureText: getMeasureTextCacheSize(),
	wrapText: getWrapTextCacheSize(),
});
