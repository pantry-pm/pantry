This source backport fixes the obsolete LZ4 frame checksum API described in
[meta/zstd#4897](https://github.com/meta/zstd/issues/4897).

The owning source fix and regression are in
[chrisbbreuer/zstd#1](https://github.com/chrisbbreuer/zstd/pull/1), commit
`a7d48c6bfd463ffae9f9bf7f3df12b2b1a676fb9`. That fork PR qualifies the change
before upstream submission, as required by Zstd's contribution guide.

The patch applies only to the original 1.5.7 source. It uses the supported
`LZ4F_contentChecksum_t`, preserves the existing LZ4 <=1.6.0 compatibility
block, and removes the request for obsolete aliases. No compression format
is disabled. Zstd's existing `test-lz4` target includes the regression in
the owning source change.

Pantry publishes this correction as a new immutable 1.5.7.2 source build;
accepted 1.5.7.1 archives remain intact. Delivery is tracked in
[pantry-pm/pantry#348](https://github.com/pantry-pm/pantry/issues/348).
