# Трасса «Спа-Франкоршам» (по мотивам)

Модель строится в Forma (проект «Спа-Франкоршам»: `~/Library/Application Support/Forma/models/Спа-Франкоршам.three.json` и `.glb`), в игру идёт копия `public/models/spa.glb`. Имена узлов и служебные точки — как у Marina Bay (`prog/_materials/ТЗ трасса Марина Бэй.md`), circuit.js и сервер читают её без переделки.

## Файлы

- `centerline.mjs` — ось: прямые и повороты-дуги с переходными кривыми (клотоиды), по часовой. Три прямые (Кеммель, спуск к Риважу, к Фань) подбираются так, чтобы круг замкнулся и был ровно 7000 м.
- `track.mjs` — все числа: ось через 1 м, рельеф (сплайн по точкам + сглаживание, вертикальные кривые), сечение (белая линия 0,3 м, поребрики 1,2 м за линией +3 см, зоны безопасности, гравий, газон, ограждения), пит-лейн (смещение оси трассы влево, 20 боксов), решётка, сектора, трибуны, пит-комплекс, земля сеткой 24 м и лес. Пишет `out/spa-data.json`, печатает проверки (радиус, уклон, замыкание, земля не выше газона).
- `parts.mjs` — код three.js для Forma: по одной части на вызов `model3d_run` (`root`, `surface`, `markings`, `grass`, `slopes`, `barriers`, `fences`, `gantry`, `pitComplex`, `paddock`, `stands`, `forest`, `service`).
- `serve.mjs` — отдаёт эту папку на http://127.0.0.1:8799, чтобы код в Forma взял `parts.mjs` и числа.
- `check.mjs` — проверка готового GLB: имена, ось, радиусы, рельеф, поребрики за линией, ограждения и пит-уолл не на трассе, пол боксов вровень, нет света и камер, бюджет; круг бота по настоящей коллизии трассы (как на сервере).

## Как пересобрать

```
node tools/track/spa/track.mjs          # числа → out/spa-data.json
node tools/track/spa/serve.mjs &        # для Forma
```

В Forma (`model3d_open` «Спа-Франкоршам»), по частям:

```js
const P = await import('http://127.0.0.1:8799/parts.mjs?' + Date.now()); P.reset(); const D = await P.load()
add(P.root(THREE))
for (const m of P.surface(THREE, D)) add(m, find('Покрытие (коллизия)'))
// дальше markings → «Разметка (без коллизии)», grass и slopes → «Газон», barriers → «Ограждения (коллизия)»,
// fences → «Сетка (без коллизии)», gantry → «Стартовый портал», pitComplex и paddock → «Пит-комплекс»,
// stands → «Трибуны», forest → «Окружение», service → «Служебное (точки и оси)»
```

Материалы: гравий (preset sand), бетон (скан ph:concrete_floor из кеша Forma, карты 512 px), отбойники (brushed-metal + Stainless Steel); остальное — простые цвета. Перед `model3d_save` убрать из сцены камеры и «Свет кадра» (иначе в GLB попадут камера и источники света).

```
cp ~/Library/Application\ Support/Forma/models/Спа-Франкоршам.glb public/models/spa.glb
node tools/track/spa/check.mjs public/models/spa.glb hard,medium,light
node tools/track/lap.mjs public/models/spa.glb
```
