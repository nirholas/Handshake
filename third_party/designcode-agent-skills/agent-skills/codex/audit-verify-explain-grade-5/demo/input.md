# Audit request

The checkout button previously submitted twice on a slow connection.
A guard was added to disable the button while the request is pending.

Evidence available:
- targeted unit test output
- browser recording of one successful checkout
- changed-file diff
