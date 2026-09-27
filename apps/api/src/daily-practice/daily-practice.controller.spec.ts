import { Reflector } from '@nestjs/core';
import { Role } from '@prisma/client';
import { REQUIRED_ROLES } from '../common/auth';
import { AdminDailyPracticeUsersController } from './admin-daily-practice-users.controller';
import { AdminDailyPracticeController } from './admin-daily-practice.controller';
import { DailyPracticeController } from './daily-practice.controller';
import { CurriculumController } from './curriculum.controller';

describe('daily practice controller RBAC', () => {
  const reflector = new Reflector();

  it('keeps member-facing routes authenticated without a role elevation', () => {
    expect(
      reflector.get(REQUIRED_ROLES, DailyPracticeController),
    ).toBeUndefined();
    expect(
      reflector.get(REQUIRED_ROLES, DailyPracticeController.prototype.today),
    ).toBeUndefined();
  });

  it('allows editors and administrators to use shared management routes', () => {
    expect(reflector.get(REQUIRED_ROLES, AdminDailyPracticeController)).toEqual(
      [Role.EDITOR, Role.ADMIN],
    );
    expect(reflector.get(REQUIRED_ROLES, CurriculumController)).toEqual(
      [Role.EDITOR, Role.ADMIN],
    );
  });

  it('keeps every user-specific management action ADMIN-only', () => {
    for (const action of ['testAccess', 'updateTestAccess'] as const) {
      expect(reflector.get(REQUIRED_ROLES, AdminDailyPracticeController.prototype[action])).toEqual([Role.ADMIN]);
    }
    expect(
      reflector.get(REQUIRED_ROLES, AdminDailyPracticeUsersController),
    ).toEqual([Role.ADMIN]);
    for (const action of [
      'users',
      'user',
      'suggest',
      'regenerate',
      'preview',
    ] as const) {
      expect(
        reflector.get(
          REQUIRED_ROLES,
          AdminDailyPracticeUsersController.prototype[action],
        ),
      ).toBeUndefined();
    }
  });
});
