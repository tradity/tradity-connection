"use strict";

function parentPath(x) {
	var match = String(x).match(/((\/[\w_-]+)+)\/[\w_-]+$/);
	return match ? match[1] : '/';
}

function locallyUnique() {
	locallyUnique.count = locallyUnique.count || 0;
	return locallyUnique.count++;
}

function detectCycle(o) {
	var seen = [];
	
	function dfs(o) {
		if (o && typeof o == 'object') {
			if (seen.indexOf(o) != -1)
				return true;
			
			seen.push(o);
			for (var key in o) {
				if (o.hasOwnProperty(key)) {
					var previousChain = dfs(o[key]);
					if (previousChain)
						return '.' + key + (previousChain === true ? '' : previousChain);
				}
			}
		}
		
		return false;
	}
	
	return dfs(o);
}

if (typeof exports != 'undefined' && exports) {
	exports.parentPath = parentPath;
	exports.locallyUnique = locallyUnique;
	exports.detectCycle = detectCycle;
	
	if (typeof require != 'undefined' && require) {
		var crypto = require('crypto');
				
		var sha256 = function (s) {
			var h = crypto.createHash('sha256');
			h.end(s);
			return h.read().toString('hex');
		}
		
		exports.sha256 = sha256;
	}
}
