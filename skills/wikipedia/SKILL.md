---
name: wikipedia
description: Look up a short, reliable summary of a person, place or topic on Wikipedia.
permissions:
  - net:en.wikipedia.org
---
# Wikipedia lookup

1. Turn the topic into a Wikipedia page title: capitalize words and replace spaces with underscores, e.g. Alan_Turing.
2. Call the web_fetch tool with url https://en.wikipedia.org/api/rest_v1/page/summary/<Title>
   and fields ["title", "description", "extract"].
3. Answer in 2-3 sentences based only on the extract, and mention that it is from Wikipedia.
4. If the page is not found, say so and suggest a more specific title.
