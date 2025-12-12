# Admin Delete Implementation - Scope Separation

## Overview

This document describes the implementation of admin-scoped soft delete for appointments, ensuring that admin deletions do not affect user visibility.

## Problem Statement

Previously, when an admin deleted an appointment, it set `isArchived = true`, which caused the appointment to disappear from both admin and user dashboards. This was incorrect behavior - admin deletions should only affect the admin view.

## Solution

Implemented a two-tier deletion system:
1. **Admin-only delete**: Sets `isDeletedByAdmin = true` - removes from admin view only
2. **Global archive**: Sets `isArchived = true` - removes from both admin and user views

## Database Schema Changes

### New Fields Added to `Appointment` Model

```prisma
model Appointment {
  // ... existing fields ...
  isDeletedByAdmin        Boolean             @default(false)
  deletedByAdminAt        DateTime?
  deletedByAdminReason    String?
  // ... rest of fields ...
  
  @@index([isDeletedByAdmin])
}
```

### Migration

- Migration file: `prisma/migrations/20251212124859_add_admin_delete_fields/migration.sql`
- Adds three new columns with appropriate indexes
- All existing appointments have `isDeletedByAdmin = false` by default

## API Changes

### Endpoints

1. **DELETE `/admin/appointments/:id`** (existing, backward compatible)
   - Default behavior: Admin-only delete
   - Sets `isDeletedByAdmin = true`
   - User can still see the appointment

2. **PATCH `/admin/appointments/:id/admin-delete`** (new, recommended)
   - Request body:
     ```typescript
     {
       reason?: string;           // Optional reason for deletion
       scope?: "admin" | "global"; // Delete scope (default: "admin")
     }
     ```
   - Supports both admin-only and global archive
   - Returns scope information in response

### Implementation Details

**Function**: `adminDeleteAppointment` in `admin.controller.ts`

- Defaults to admin-only delete (`scope = "admin"`)
- If `scope = "global"`, sets both `isArchived = true` and `isDeletedByAdmin = true`
- Validates admin ownership before deletion
- Returns appropriate error messages for already-deleted appointments
- Logs deletion actions for audit trail

## Query Changes

### Admin Queries

**`adminGetAppointments`**:
```typescript
where: {
  isArchived: false,
  isDeletedByAdmin: false  // Filter out admin-deleted appointments
}
```

**`adminGetAppointmentDetails`**:
- No filter applied - admin can still view admin-deleted appointments for audit purposes
- Authorization check still enforced

### User Queries

**`getMyAppointments`**, **`getPendingAppointments`**, **`getAppointmentsByPatient`**:
```typescript
where: {
  userId: req.user.id,
  isArchived: false  // Only filter by isArchived - NOT isDeletedByAdmin
}
```

**Key Point**: User queries explicitly do NOT filter by `isDeletedByAdmin`, ensuring admin deletions don't affect user visibility.

## Frontend Changes

### API Client Update

**`lib/appointments-admin.ts`**:
- Updated `deleteAppointment` function to support optional `reason` and `scope` parameters
- Uses PATCH endpoint when options are provided
- Falls back to DELETE for backward compatibility
- Returns scope information in response

### UI Updates

**`app/admin/appointments/page.tsx`**:
- Updated confirmation modal message to clarify admin-only delete behavior
- Message: "This will remove the appointment from the admin dashboard only. The user will still be able to see their appointment."

## Behavior Summary

### After Admin Delete (Admin-Only)

1. **Admin Dashboard**: Appointment is hidden (`isDeletedByAdmin = true`)
2. **User Dashboard**: Appointment remains visible (not filtered by `isDeletedByAdmin`)
3. **Database**: Appointment record still exists with deletion metadata

### After Global Archive

1. **Admin Dashboard**: Appointment is hidden (both `isArchived = true` and `isDeletedByAdmin = true`)
2. **User Dashboard**: Appointment is hidden (`isArchived = true` filters it out)
3. **Database**: Appointment record still exists with archive metadata

## Migration Notes

- **Existing Data**: All existing appointments have `isDeletedByAdmin = false`
- **Backward Compatibility**: DELETE endpoint still works without body
- **No Data Loss**: Previous hard deletes cannot be recovered without backups
- **Future-Proof**: New system prevents accidental user-facing deletions

## Testing Checklist

- [x] Admin delete hides appointment from admin list
- [x] Admin delete does NOT hide appointment from user dashboard
- [x] Global archive hides appointment from both admin and user dashboards
- [x] Admin can still view admin-deleted appointments in details view
- [x] User queries correctly ignore `isDeletedByAdmin` filter
- [x] Backward compatibility with existing DELETE endpoint
- [x] Error handling for already-deleted appointments

## API Response Examples

### Admin-Only Delete
```json
{
  "success": true,
  "message": "Appointment deleted from admin dashboard (user view unaffected)",
  "scope": "admin"
}
```

### Global Archive
```json
{
  "success": true,
  "message": "Appointment archived globally (removed from all views)",
  "scope": "global"
}
```

## Security Considerations

1. **Authorization**: Only admin who owns the appointment can delete it
2. **Audit Trail**: Deletion timestamp and reason are recorded
3. **Data Integrity**: Soft delete preserves data for recovery/audit
4. **Scope Control**: Global archive requires explicit `scope = "global"` parameter

## Future Enhancements

Potential improvements:
1. Admin "trash" view to list `isDeletedByAdmin = true` appointments
2. Restore functionality for admin-deleted appointments
3. Bulk delete operations with scope selection
4. Deletion reason tracking and reporting

---

*Last Updated: 2025-12-12*
*Implementation Status: Complete ✅*

