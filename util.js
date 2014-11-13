"use strict";

function parentPath(x) {
	var match = String(x).match(/((\/[\w_-]+)+)\/[\w_-]+$/);
	return match ? match[1] : '/';
}

if (typeof exports != 'undefined' && exports) {
	exports.parentPath = parentPath;
}
