# Changelog

## [2026.10.0](https://github.com/FHeilmann/lovelace-rehoboam/compare/0.18.0...2026.10.0) (2026-10-22)


### Features

* add a title and a templated subtitle (0.18.0) ([2694862](https://github.com/FHeilmann/lovelace-rehoboam/commit/269486266ddbcf73336f70058d248c601b347afe))
* add hacs.json configuration ([09380bc](https://github.com/FHeilmann/lovelace-rehoboam/commit/09380bce9c640911550f2287f4250d420991e29a))
* add lovelace-rehoboam.js card and visual editor component ([e8c2ceb](https://github.com/FHeilmann/lovelace-rehoboam/commit/e8c2ceb7ad26b136514b9f4959b6fa0a671022bd))
* edit state maps in the editor and the playground ([7b06d14](https://github.com/FHeilmann/lovelace-rehoboam/commit/7b06d1453b05c633a0f491a540b0761ad52285bc))
* **editor:** add sliders and tooltips, rename masses to strata (0.15.0) ([bc84ef5](https://github.com/FHeilmann/lovelace-rehoboam/commit/bc84ef58ee8e79c191419ea4f085e9dc88882691))
* integrate full WebGL Rehoboam divergence card and visual editor ([7041607](https://github.com/FHeilmann/lovelace-rehoboam/commit/7041607fe1fea12bb8efd8206a525f156192fde1))
* localize the card, the editor and the playground (0.17.0) ([9e37216](https://github.com/FHeilmann/lovelace-rehoboam/commit/9e3721686bfd6ec2be937438d7aa68e4744abbc6))
* **playground:** publish harness.html as a GitHub Pages playground (0.16.0) ([7619eda](https://github.com/FHeilmann/lovelace-rehoboam/commit/7619edaa3c6656894174a2382b6b1c5f3e063c1e))
* update card to v0.14.0 ([d445629](https://github.com/FHeilmann/lovelace-rehoboam/commit/d445629e45fa2f7a79e4e444b735745f53fe1603))


### Bug fixes

* **ci:** use hacs/action@main and ignore unconfigured repo metadata checks ([4037f58](https://github.com/FHeilmann/lovelace-rehoboam/commit/4037f58c38a2207e459bdd6a303f712020a9f9fa))
* harden editor and WebGL lifecycle, set 500px default height, update repo URLs ([6baedb0](https://github.com/FHeilmann/lovelace-rehoboam/commit/6baedb0cd4978e239be6aff02853937390c789eb))
* keep callouts visible across config changes ([b9b819c](https://github.com/FHeilmann/lovelace-rehoboam/commit/b9b819cdea90d250c05db27b0fe0f5746e2dc026))
* **security:** close the playground script link, check CSS values, pin actions ([12db758](https://github.com/FHeilmann/lovelace-rehoboam/commit/12db758a54585d345cdef68a0254dbe93751ddfa))


### Performance

* optimize shader radial culling, LUT trig tables, sqrt encoding, AA & dithering for MT8163 ([99b41e2](https://github.com/FHeilmann/lovelace-rehoboam/commit/99b41e2dc4f52b7ee6d6e69c4beac90737314162))


### Code changes

* **editor:** group settings into smaller related sections ([7b69a5c](https://github.com/FHeilmann/lovelace-rehoboam/commit/7b69a5c80657c3f5a9d1a73a7c86dff50e29f189))
* one settings list for card, editor, playground and README ([a2868be](https://github.com/FHeilmann/lovelace-rehoboam/commit/a2868be214247fe88e7608b08f2e6658e7bc5dcb))
* standardize custom element tag exclusively to lovelace-rehoboam ([99d452e](https://github.com/FHeilmann/lovelace-rehoboam/commit/99d452ee560fd659408a4ee3b888a40fc196d388))


### Documentation

* add comprehensive README with HACS instructions ([7558eec](https://github.com/FHeilmann/lovelace-rehoboam/commit/7558eec524ded04d06a9a6804f232f325ccda3ac))
* redesign the README with screenshots ([ed030a8](https://github.com/FHeilmann/lovelace-rehoboam/commit/ed030a8d87fd7be797bd42897e7c9ebd352c8cbf))
* show callouts coming and going in the hero animation ([9f950c8](https://github.com/FHeilmann/lovelace-rehoboam/commit/9f950c8a35d8b6abc9e9272d29896ac28aba9352))


### CI

* release with release-please and calendar versions ([ef17a96](https://github.com/FHeilmann/lovelace-rehoboam/commit/ef17a96b7b52f2b935b42243af8b321e490ee29c))
