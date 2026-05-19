---
trigger: always_on
---

- All API Responsed should be wrapped by unified functions.
    - For example: 
        - c.json(success(CODE.SUCCESS, null, data))
        - c.json(error(CODE.UNAUTHORIZED, 'please login first'))
- 