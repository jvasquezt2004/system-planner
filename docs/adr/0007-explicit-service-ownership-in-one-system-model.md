# Keep Service ownership explicit in one shared System design

The system overview and focused Service views refer to the same authoritative System design, rather than independently authored copies. Components have one owning Service or sit at system scope as shared or independent resources; Connections describe usage and may target Components or Services directly. Ownership changes are explicit, so visual placement alone cannot transfer a resource between Services. This requires keeping ownership and view presentation distinct, but prevents layout edits and duplicated views from silently changing the architecture or producing competing versions of a shared resource.

Services own Components rather than other Services. Larger organizational boundaries use separate, nestable Groups, which may describe business domains, regions, or networks without becoming owners. This keeps ownership distinct from organization and placement.

Group membership is explicit and may overlap independently of Service ownership. Moving a Group moves its members, with each underlying Component moving once even when memberships overlap. Drawing or resizing a Group does not infer new membership.
