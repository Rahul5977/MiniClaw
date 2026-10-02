---
name: weather
description: Current weather and a 3-day forecast for any city, from wttr.in.
permissions:
  - net:wttr.in
---
# Weather

1. Work out the city. If the user didn't name one and you don't know where they are, ask.
2. For the **current weather**, call `web_fetch` with this URL (replace spaces in the city with `+`):
   `https://wttr.in/<City>?format=%l:+%C,+%t+(feels+like+%f),+wind+%w,+humidity+%h`
3. For a **forecast** ("tomorrow", "this weekend"), call `web_fetch` with
   `https://wttr.in/<City>?format=j2` and
   `fields: ["weather.*.date", "weather.*.mintempC", "weather.*.maxtempC", "weather.*.sunHour"]`.
   The lists are for today, tomorrow and the day after.
4. Reply in one or two friendly sentences, in °C. Don't invent conditions the data doesn't show.
