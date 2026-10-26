# Projects represent systems with linked database Designs

A Project represents one overall system, with a System design and linked database Designs. Database components refer to their associated Designs so the architecture and schema editors describe the same database, and a Project can contain distinct databases with distinct schemas. This replaces the single-Design-per-Project boundary: adding an isolated diagram would be cheaper, but would leave architecture and database structure disconnected. Existing projects retain their database Design when brought into the expanded model; the Design remains authoritative and its sandbox remains disposable as in ADR-0001.

A Database component may remain conceptual without a linked Design. Opening schema detail for a supported database uses the existing database-design views; architecture does not require a schema or imply schema-editor support for every database technology represented on the canvas.

Multiple Database components may intentionally link to the same Design, for example to describe a primary and replica with a Shared schema. The shared link is visibly identified, and editing that Design updates schema detail everywhere it is linked. The Component identifies the architectural database; the Design describes its schema, not runtime contents. Independent schemas use independent Designs.
