# Languages

 Installed languages on the system are in [`languages`](../languages): one file per language. The name is the language's code + `.json` The server comes with English, `en.json`. Posts aren't translated.

To add a language, copy `en.json` or another language file to a file named after the new language's code (`es.json`, `pt-BR.json`), change `name` to the language's own name and translate the messages, then build and restart the server:

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
- A part of language install is ensuring that challenge audio can be read in that language. Please put the audio in `src/challenge/voices/`

- `DEFAULT_LANGUAGE` (`en`) is the language of anyone who hasn't chosen one. 

Users pick any of the server's languages when they register, and can edit their language at any time. Use `GET /languages` to list them ([API.md](API.md#get-languages)).

Please consider opening a PR on the repo to add language support to the base instance.