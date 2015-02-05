/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

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
}
