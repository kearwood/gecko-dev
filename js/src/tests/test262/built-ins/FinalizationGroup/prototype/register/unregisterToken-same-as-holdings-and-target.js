// Copyright (C) 2019 Leo Balter. All rights reserved.
// This code is governed by the BSD license found in the LICENSE file.

/*---
esid: sec-finalization-group.prototype.register
description: unregisterToken may be the same as holdings and target
info: |
  FinalizationGroup.prototype.register ( target , holdings [, unregisterToken ] )

  1. Let finalizationGroup be the this value.
  2. If Type(finalizationGroup) is not Object, throw a TypeError exception.
  3. If finalizationGroup does not have a [[Cells]] internal slot, throw a TypeError exception.
  4. If Type(target) is not Object, throw a TypeError exception.
  5. If SameValue(target, holdings), throw a TypeError exception.
  6. If Type(unregisterToken) is not Object,
    a. If unregisterToken is not undefined, throw a TypeError exception.
    b. Set unregisterToken to empty.
  7. Let cell be the Record { [[Target]] : target, [[Holdings]]: holdings, [[UnregisterToken]]: unregisterToken }.
  8. Append cell to finalizationGroup.[[Cells]].
  9. Return undefined.
features: [FinalizationGroup]
---*/

var fg = new FinalizationGroup(function() {});

var target = {};
assert.throws(TypeError, () => fg.register(target, target, target));

reportCompare(0, 0);
