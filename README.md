# 今天吃什麼 🍜

有選擇障礙時用的午餐轉盤：抓附近的店（或自己存的清單）做成轉盤，轉到哪家就吃哪家。

- 店家資料：在 `config.js` 填 Google Places API (New) 金鑰就用 Google 地圖資料，沒填則用 OpenStreetMap。
- 純前端網頁，不需要建置。本機測試：雙擊 `start.bat`，開 http://localhost:5173 。

金鑰會公開在網頁上，請務必在 Google Cloud 把它限制在這個網站的網址，並只開放 Places API (New)。
