- `async` functions always end with `Async`, eg `someFnAsync`
- boolean variables always start with a question word, eg `isDone`, `hasErrors`
- Handle discriminated unions exhaustively: `switch` on the discriminant and call `impossible(value)` in the `default` arm. The `never` parameter makes any unhandled variant a compile error at every switch site.
- Dependencies (db, logger, etc) should always be the first argument. If more than one dependency, should be an object, otherwise can be destructured. This should only include the dependencies that are needed (not the full Deps object).
- Define types that will be used in multiple different modules in a `shared/` module

TODO(Later): Figure out the story behind if/when Typescript gets compiled to Javascript and whether imports should do Typescript or Javascript
