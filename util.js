"use strict";

function parentPath(x) {
	var match = String(x).match(/((\/[\w_-]+)+)\/[\w_-]+$/);
	return match ? match[1] : '/';
}

if (typeof exports != 'undefined' && exports) {
	exports.parentPath = parentPath;
	
	if (typeof require != 'undefined' && require) {
		var crypto = require('crypto');
				
		function sha256(s) {
			var h = crypto.createHash('sha256');
			h.end(s);
			return h.read().toString('hex');
		}
		
		expots.sha256 = sha256;
	}
}
