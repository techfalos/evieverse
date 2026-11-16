# Languages

What the server says to its users, which is its errors and the notes that come with some results, is in the language files of [`src/languages`](../src/languages): one file per language, named after the language's code. The server comes with English, `en.json`. Posts aren't translated.

To add a language, copy `en.json` to a file named after the new language's code (`es.json`, `pt-BR.json`), change `name` to the language's own name and translate the messages, then build and restart the server:

```json
{ "name": "Español",
  "messages": {
    "user.username_taken": "el nombre de usuario ya está en uso",
    "follow.limit": "puedes seguir como máximo a {max} usuarios",
    "upload.rate_limited": { "one": "demasiados archivos; inténtalo de nuevo en {count} segundo",
                             "other": "demasiados archivos; inténtalo de nuevo en {count} segundos" } } }
```

- Keep the keys and the `{placeholders}` as they are, and translate the words around them.
- A message with forms (`one`, `other`) depends on a number. Give it the forms the language has, of `zero`, `one`, `two`, `few`, `many` and `other`; `other` is required.
- A translation can be partial. A message the file lacks is said in the default language, and the server logs which ones those are when it starts.
- `DEFAULT_LANGUAGE` (`en`) is the language of anyone who hasn't chosen one. The server doesn't start if that language has no file, or if a file in the folder isn't a language.

Users pick any of the server's languages when they register and can change it later, and `GET /languages` lists them ([API.md](API.md#languages)).
