# Changelog

## [2026.10.0](https://github.com/FHeilmann/lovelace-rehoboam/compare/0.18.0...2026.10.0) (2026-10-22)


### Features

* add a title and a templated subtitle (0.18.0) ([6edd33c](https://github.com/FHeilmann/lovelace-rehoboam/commit/6edd33c2e21f7ddfd650b0fe47d975a3ba2a09c4))
* add hacs.json configuration ([cbb395a](https://github.com/FHeilmann/lovelace-rehoboam/commit/cbb395aa72535e306a82f1ab28baf1499b33e135))
* add lovelace-rehoboam.js card and visual editor component ([9ceb991](https://github.com/FHeilmann/lovelace-rehoboam/commit/9ceb9916d4861815e8681e4162e9067ba327e7c3))
* edit state maps in the editor and the playground ([92ad600](https://github.com/FHeilmann/lovelace-rehoboam/commit/92ad600119d25a304a9891bac10790bbfeed2ec2))
* **editor:** add sliders and tooltips, rename masses to strata (0.15.0) ([0fbe2e9](https://github.com/FHeilmann/lovelace-rehoboam/commit/0fbe2e9fa09f6c27dc128e0334abe5084279fd65))
* integrate full WebGL Rehoboam divergence card and visual editor ([811b572](https://github.com/FHeilmann/lovelace-rehoboam/commit/811b5726d8aed03fa56982e33ff93b602b8bc936))
* localize the card, the editor and the playground (0.17.0) ([d1cfd53](https://github.com/FHeilmann/lovelace-rehoboam/commit/d1cfd53dd6d1845206bcc15e56dfe46f6070628a))
* **playground:** publish harness.html as a GitHub Pages playground (0.16.0) ([bb2fbfe](https://github.com/FHeilmann/lovelace-rehoboam/commit/bb2fbfef88b92477c4c93529c301a09fe8b65770))
* update card to v0.14.0 ([86776d8](https://github.com/FHeilmann/lovelace-rehoboam/commit/86776d8af854d4f44e1773f2e134beeb701be2c6))


### Bug fixes

* **ci:** use hacs/action@main and ignore unconfigured repo metadata checks ([14d7db5](https://github.com/FHeilmann/lovelace-rehoboam/commit/14d7db5d530fe02f3a5f77b1b418d8f7bcc9126b))
* harden editor and WebGL lifecycle, set 500px default height, update repo URLs ([e9e7ab1](https://github.com/FHeilmann/lovelace-rehoboam/commit/e9e7ab153ecc40a48fcfe9852cd907c0bd02a9f2))
* keep callouts visible across config changes ([8649d28](https://github.com/FHeilmann/lovelace-rehoboam/commit/8649d28eff2452a886213d753a3900813ac22117))


### Performance

* optimize shader radial culling, LUT trig tables, sqrt encoding, AA & dithering for MT8163 ([4560e34](https://github.com/FHeilmann/lovelace-rehoboam/commit/4560e34a0bde933a0f5a41c72e2680dff9a19165))


### Code changes

* **editor:** group settings into smaller related sections ([baa35f5](https://github.com/FHeilmann/lovelace-rehoboam/commit/baa35f55e3a353e5aa26170efa9813601b9bcfdb))
* one settings list for card, editor, playground and README ([02e60eb](https://github.com/FHeilmann/lovelace-rehoboam/commit/02e60ebf902a4327f6ffae87ade2e3cac9f5a844))
* standardize custom element tag exclusively to lovelace-rehoboam ([133ad05](https://github.com/FHeilmann/lovelace-rehoboam/commit/133ad05916bf6536601c1baa0d794a971dd48a4b))


### Documentation

* add comprehensive README with HACS instructions ([45ba657](https://github.com/FHeilmann/lovelace-rehoboam/commit/45ba6573970dbe9b387fa0bad456119694252db2))
* redesign the README with screenshots ([1edbdf8](https://github.com/FHeilmann/lovelace-rehoboam/commit/1edbdf820618b5421590f6af229ab78e16e41b9a))
* show callouts coming and going in the hero animation ([a9f1021](https://github.com/FHeilmann/lovelace-rehoboam/commit/a9f1021d70a8539e453e75c08fbd2d9271bcd8c1))


### CI

* release with release-please and calendar versions ([77f87d2](https://github.com/FHeilmann/lovelace-rehoboam/commit/77f87d24942ab7cb6aeacbb9a26b317bffb61408))
